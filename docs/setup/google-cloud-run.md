# Google Cloud Run

Two Cloud Run services and a Firestore database, from `deploy/terraform/cloud-run`:

- **`titlesearch`**: the API, UI, and MCP server. Its service account can use only Titlesearch's Firestore database and its own secrets.
- **`titlesearch-renderer`**: Chromium behind the egress proxy. Its service account has no roles at all, so a compromised page can get only a powerless token from the metadata server (invariant 8). The API calls it with a generated token.

## 1. Pick an identity provider

Read [identity-providers.md](identity-providers.md). For Claude to connect, your provider must issue JWT access tokens, so Google sign-in alone isn't enough here. Register the web client's redirect URI as `https://<server>/auth/callback`.

## 2. Build and push the images

```sh
gcloud artifacts repositories create titlesearch --repository-format=docker --location=us-central1
docker build -f deploy/container/Dockerfile --target api      -t us-central1-docker.pkg.dev/PROJECT/titlesearch/api .
docker build -f deploy/container/Dockerfile --target renderer -t us-central1-docker.pkg.dev/PROJECT/titlesearch/renderer .
docker push us-central1-docker.pkg.dev/PROJECT/titlesearch/api
docker push us-central1-docker.pkg.dev/PROJECT/titlesearch/renderer
```

Note each pushed digest (`…@sha256:…`).

## 3. Store the secrets you have

Terraform generates the session secret and the renderer token. Add any others yourself, so their values never pass through Terraform state:

```sh
printf %s "$OIDC_CLIENT_SECRET" | gcloud secrets create titlesearch-oidc-client-secret --data-file=-
printf %s "$PORKBUN_API_KEY"     | gcloud secrets create titlesearch-porkbun-key --data-file=-
printf %s "$PORKBUN_SECRET_KEY"  | gcloud secrets create titlesearch-porkbun-secret --data-file=-
```

## 4. Apply

```hcl
# main.tf
module "titlesearch" {
  source         = "github.com/prodxpdev/titlesearch//deploy/terraform/cloud-run"
  project_id     = "my-project"
  region         = "us-central1"
  api_image      = "us-central1-docker.pkg.dev/my-project/titlesearch/api@sha256:…"
  renderer_image = "us-central1-docker.pkg.dev/my-project/titlesearch/renderer@sha256:…"

  oidc_issuer           = "https://acme.okta.com/oauth2/aus123"
  oidc_client_id        = "0oa123"
  allowed_email_domains = ["acme.dev"]

  secret_ids = {
    OIDC_CLIENT_SECRET     = "titlesearch-oidc-client-secret"
    PORKBUN_API_KEY        = "titlesearch-porkbun-key"
    PORKBUN_SECRET_API_KEY = "titlesearch-porkbun-secret"
  }
}

output "url" { value = module.titlesearch.url }
```

```sh
terraform init && terraform apply
```

Without `public_url`, the server uses its Cloud Run URL. For a custom domain, map it to the `titlesearch` service, set `public_url`, and apply again.

## 5. Connect Claude

Open the URL to check that sign-in works. Then, in Claude, add a custom connector with the URL `https://<server>/mcp`.

## Notes

- **WHOIS.** Extensions without RDAP fall back to WHOIS on TCP port 43. Cloud Run allows outbound TCP on every port except 25, but this hasn't been verified on a live deployment. If it's blocked, those extensions report "Couldn't check".
- **Firestore TTL.** Policies on `expireAt` delete expired documents within about a day; reads check the exact expiry themselves.
- **Costs.** Both services scale to zero. Each capture uses about 2 GiB for a few seconds.
