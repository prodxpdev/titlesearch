# 22. Terraform modules, and how secrets reach each target

- Status: accepted (validated, not yet applied to a live account)
- Date: 2026-10-01

## Context

`CLAUDE.md` asks for optional Terraform modules for Cloud Run and Lambda, and for secrets to come from each platform's secret store (invariant 6).

## Decision

- **Two root modules**, `deploy/terraform/cloud-run` and `deploy/terraform/aws-lambda`, with provider versions pinned and locked for Linux, macOS, and Windows. CI runs `terraform fmt -check` and `validate` on both.
- **Identities.**
  - **API:** may use only Titlesearch's database or table and its own secrets.
  - **Renderer on Cloud Run:** a service account with no roles.
  - **Renderer on Lambda:** a role that can write its logs and read its own token, which only lets a caller use the renderer itself.
- **Secrets.**
  - Terraform generates the session secret and the renderer token.
  - Secrets that deployers hold (registrar keys, the OIDC client secret, the Anthropic key) are created outside Terraform and passed by ID or ARN, so their values never enter Terraform state.
  - Cloud Run injects them from Secret Manager as environment variables.
  - Lambda can't, and container-image functions can't use the Parameters and Secrets extension layer, so the API and renderer read `NAME_ARN` from the Secrets Manager API at startup with their own credentials.
- **Public URL.**
  - Cloud Run's service URL is deterministic, so it's computed before the service exists.
  - A Lambda function URL isn't, and putting it in the function's environment would be a dependency cycle. Terraform writes it to a secret instead, and the API reads `PUBLIC_URL_ARN`.
- **Ingress.**
  - Both API services are public, because the app authenticates every request itself (ADR 19).
  - Both renderer services are reachable over HTTPS but answer only with the generated token.
  - A deployer who wants network-level isolation for the renderer can add internal ingress and a VPC connector on Cloud Run, or a VPC with an internal load balancer on ECS. The guides mention this but the modules don't require it.
- **No ECS module.** The images run unchanged on ECS; the AWS guide lists what the task definitions need.

## Consequences

- Not yet applied to a live account. The guides say so.
- Rotating the generated secrets is `terraform apply -replace=random_password.session` (which signs everyone out) or `-replace=random_password.renderer_token`.
