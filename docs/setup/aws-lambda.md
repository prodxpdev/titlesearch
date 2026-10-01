# AWS Lambda (and ECS)

Two Lambda functions, each with a function URL, plus a DynamoDB table and Secrets Manager secrets, from `deploy/terraform/aws-lambda`. The images run through the AWS Lambda Web Adapter, which is built into both.

- **`titlesearch`**: the API, UI, and MCP server. Its role can use only the cache table and its own secrets.
- **`titlesearch-renderer`**: Chromium behind the egress proxy. Its role can write its logs and read its own token, and nothing else (invariant 8).

Lambda can't put secrets in environment variables, so each secret is passed as `NAME_ARN` and read from Secrets Manager at startup. The function URL exists only after the function does, so Terraform stores it in a secret too (`PUBLIC_URL_ARN`).

## 1. Pick an identity provider

Read [identity-providers.md](identity-providers.md). For Claude to connect, your provider must issue JWT access tokens.

## 2. Build and push the images to ECR

Lambda runs images from ECR only. Build for the architecture you deploy (`arm64` is the module's default):

```sh
aws ecr create-repository --repository-name titlesearch/api
aws ecr create-repository --repository-name titlesearch/renderer
docker buildx build --platform linux/arm64 -f deploy/container/Dockerfile --target api      -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/titlesearch/api --push .
docker buildx build --platform linux/arm64 -f deploy/container/Dockerfile --target renderer -t ACCOUNT.dkr.ecr.REGION.amazonaws.com/titlesearch/renderer --push .
```

## 3. Store the secrets you have

```sh
aws secretsmanager create-secret --name titlesearch/oidc-client-secret --secret-string "$OIDC_CLIENT_SECRET"
aws secretsmanager create-secret --name titlesearch/porkbun-key        --secret-string "$PORKBUN_API_KEY"
aws secretsmanager create-secret --name titlesearch/porkbun-secret     --secret-string "$PORKBUN_SECRET_KEY"
```

## 4. Apply

```hcl
module "titlesearch" {
  source             = "github.com/prodxpdev/titlesearch//deploy/terraform/aws-lambda"
  api_image_uri      = "ACCOUNT.dkr.ecr.REGION.amazonaws.com/titlesearch/api@sha256:…"
  renderer_image_uri = "ACCOUNT.dkr.ecr.REGION.amazonaws.com/titlesearch/renderer@sha256:…"

  oidc_issuer           = "https://acme.us.auth0.com/"
  oidc_client_id        = "abc123"
  allowed_email_domains = ["acme.dev"]

  secret_arns = {
    OIDC_CLIENT_SECRET     = "arn:aws:secretsmanager:…:secret:titlesearch/oidc-client-secret-…"
    PORKBUN_API_KEY        = "arn:aws:secretsmanager:…:secret:titlesearch/porkbun-key-…"
    PORKBUN_SECRET_API_KEY = "arn:aws:secretsmanager:…:secret:titlesearch/porkbun-secret-…"
  }
}

output "url" { value = module.titlesearch.url }
```

For a custom domain, put CloudFront in front of the API's function URL, set `public_url` to your domain, and add the function URL's host to `extra_hosts`. CloudFront forwards that host to the function.

## 5. Connect Claude

Open the URL to check sign-in, then add a custom connector in Claude with `https://<server>/mcp`.

## ECS and Fargate

The same images run unchanged as two services. The Lambda adapter stays inert. Give them:

- **API task:** `CACHE_BACKEND=dynamodb`, `DYNAMODB_TABLE`, `AWS_REGION`, and the settings in [README.md](README.md#settings). Pass secrets with the task definition's `secrets` field (ECS injects them as environment variables), or as `NAME_ARN`. The task role needs the same DynamoDB and Secrets Manager permissions as the Lambda module grants.
- **Renderer task:** `RENDERER_TOKEN` as a secret, a task role with no permissions, and a security group that allows outbound 80 and 443 only. Put it behind an internal load balancer, and set the API's `RENDERER_URL` to it over HTTPS.

## Notes

- **WHOIS.** Outbound TCP 43 is open for Lambda functions outside a VPC. Inside a VPC it needs a NAT gateway. Not yet verified on a live deployment.
- **Timeouts.** The API function allows 120 seconds; an assessment of many extensions can take most of that.
