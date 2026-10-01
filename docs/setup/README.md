# Deploying Titlesearch

A deployed Titlesearch serves the web UI, the REST API, and the MCP server at `/mcp`, behind your organization's sign-in. Add `https://<your server>/mcp` to Claude as a custom connector.

| Target | Guide | Cache | Previews | OAuth |
|---|---|---|---|---|
| Google Cloud Run | [google-cloud-run.md](google-cloud-run.md) | Firestore | Renderer service | Your identity provider issues the tokens |
| AWS Lambda (or ECS) | [aws-lambda.md](aws-lambda.md) | DynamoDB | Renderer function | Your identity provider issues the tokens |
| Cloudflare Workers | [cloudflare-workers.md](cloudflare-workers.md) | D1 | Browser Rendering | The Worker issues the tokens; your provider signs people in |

Pick an identity provider first: [identity-providers.md](identity-providers.md). Whatever the target, Titlesearch is read-only, and it isn't a trademark search.

> **Status.** These targets are built and tested locally: emulators for Firestore and DynamoDB, and workerd for the Worker, including the full OAuth flow. CI builds and smoke-tests the container images and validates the Terraform. They haven't yet been run on a live Google Cloud, AWS, or Cloudflare account. On a first deployment, check sign-in, health checks, and WHOIS egress, and please report what you find.

## Settings

Every target reads the same settings. They're environment variables on Cloud Run and AWS, and vars and secrets on Workers. **Secrets** must come from the platform's secret store, never plain environment variables or files. A problem with the configuration stops startup with a message naming the setting, never its value.

| Setting | Required | Meaning |
|---|---|---|
| `PUBLIC_URL` | Yes | Where users reach the server, as an `https://` origin. Only this host is answered. |
| `EXTRA_HOSTS` | | Other Host values to accept, comma-separated (a Lambda function URL behind CloudFront, for example). |
| `OIDC_ISSUER` | Yes | Your identity provider's issuer URL. |
| `OIDC_AUDIENCE` | | The `aud` access tokens carry. Defaults to `PUBLIC_URL` + `/mcp`. Cloud Run and AWS only. |
| `OIDC_CLIENT_ID` | For sign-in | The OAuth client for browser sign-in, and, on Workers, for the MCP sign-in step. |
| `OIDC_CLIENT_SECRET` | Secret | That client's secret. Omit for a public client: PKCE protects the exchange. |
| `SESSION_SECRET` | Secret, required | At least 32 random characters. Signs session cookies. Terraform generates it. |
| `ALLOWED_EMAILS` | One rule is required | Verified email addresses allowed in, comma-separated. |
| `ALLOWED_EMAIL_DOMAINS` | | Verified email domains allowed in. |
| `ALLOWED_SUBJECTS` | | OAuth subjects (`sub`) allowed in. |
| `REQUIRED_SCOPE` | | A scope your provider grants only to permitted users. Access tokens only. |
| `REQUIRED_ROLE` | | An app role your provider assigns only to permitted users (the `roles` claim). |
| `GODADDY_ENABLED` | | `true` (default) or `false`. |
| `WHOIS_ENABLE` | | Extra WHOIS extensions, such as `de` (ADR 8). |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | Secrets | Prices from Porkbun. A sandbox key (`pk1_sb_…`) is recommended: see ADR 17. |
| `NAMECOM_USERNAME`, `NAMECOM_TOKEN` | Token is a secret | Prices from Name.com. `NAMECOM_ENVIRONMENT=test` uses its sandbox. |
| `ANTHROPIC_API_KEY` | Secret | Server-side market-overlap judgment. Without it, Claude judges in chat. |
| `ASSESSMENT_MODE` | | `server` (a model here judges), `client`, or `off`. `anthropic` is the old name for `server`. |
| `ASSESSMENT_PROVIDER` | | `anthropic` (default) or `openai-compatible`, for OpenRouter, Groq, Together, or your own vLLM or llama.cpp server. |
| `ASSESSMENT_MODEL`, `ASSESSMENT_EFFORT` | | Defaults: `claude-opus-5-5`, `medium`. |
| `ASSESSMENT_BASE_URL` | For `openai-compatible` | The server's base URL, such as `https://vllm.internal.example/v1`. |
| `OPENAI_COMPATIBLE_API_KEY` | Secret | That server's key, if it needs one. Sent only over HTTPS. |
| `RENDERER_URL`, `RENDERER_TOKEN` | Token is a secret | The renderer service, for screenshots. |
| `RATE_LIMIT_PER_MINUTE`, `CONCURRENCY` | | Per-user request limit (default 120 a minute) and outbound ceiling (default 8). |
| `LOG_LEVEL` | | `error`, `warn`, `info` (default), or `debug`. Logs are JSON, with secrets redacted. |

The container also reads `CACHE_BACKEND` (`firestore`, `dynamodb`, or `memory`), `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE`, `DYNAMODB_TABLE`, `AWS_REGION`, and `PORT`. On AWS, any secret, and `PUBLIC_URL`, may be given as `NAME_ARN`, a Secrets Manager ARN read at startup.

## Building the images

From the repository root:

```sh
docker build -f deploy/container/Dockerfile --target api      -t titlesearch-api .
docker build -f deploy/container/Dockerfile --target renderer -t titlesearch-renderer .
```

Push both to your registry and deploy them by digest. The renderer image is about 1 GB, mostly Chromium and fonts.
