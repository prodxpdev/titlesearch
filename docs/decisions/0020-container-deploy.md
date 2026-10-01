# 20. Container targets: the API image and a separate renderer service

- Status: accepted (not yet run on a live Cloud Run or AWS account)
- Date: 2026-10-01

## Context

`CLAUDE.md` asks for one container image for Cloud Run and AWS Lambda (through the Lambda Web Adapter), which should also work on ECS/Fargate. "In the container image, the renderer runs as a separate service or sidecar with its own egress policy, not in the API process." Invariant 8 says the renderer has no credentials and no access to the cache, secrets, or cloud metadata.

## Decision

- **One Dockerfile, two targets** (`deploy/container/Dockerfile`):
  - `api`: the Hono app as a `bun build --compile` binary on distroless `cc-debian12:nonroot`, with the Lambda Web Adapter extension. On Cloud Run and ECS the adapter is inert. The same image runs on all three. The renderer image carries the adapter too.
  - `renderer`: Debian slim, with Chromium's libraries and fonts and the pinned chrome-headless-shell. Chromium is downloaded during the build by our own installer, which checks the SHA-256 from `chromium-manifest.json`.
  - Base images are pinned by digest. CI builds both images and runs a smoke test of each: the API's 401 challenge, and a real capture of example.com.
- **The renderer is a separate service, not a sidecar.**
  - A Cloud Run sidecar shares the instance's network namespace, and so its metadata server and service-account token. A separate Cloud Run service (or Lambda function, or ECS service) gets its own identity, so the guides give it one with no IAM permissions. A compromised Chromium can then reach only a powerless token.
  - The API talks to it over HTTPS (`RENDERER_URL`) with a shared bearer token. Plain HTTP is accepted only to a loopback address, for local testing.
  - The renderer receives a normalized domain and returns the capture. It never touches the cache.
- **The API treats the renderer as untrusted.** Every image must be a RIFF WebP of the expected dimensions, under 1 MB. It's re-hashed; the renderer's hash is ignored. Rendered text is capped. Only then is anything stored and served from our origin.
- **Chromium runs with `--no-sandbox` in the renderer image, and only there.** Its sandbox needs user namespaces, which Cloud Run and Lambda don't provide. The isolation boundary is the service: Cloud Run's instance sandbox, a Firecracker microVM on Lambda, and a task with no role on ECS. The egress proxy and the flags that leave Chromium no other network path are unchanged, and the isolation suite still covers them. `noSandbox` is a renderer option the CLI never sets.
- **Configuration** comes from environment variables, validated by one Zod schema shared with the Workers target (`@titlesearch/deploy`). Errors name the setting, never its value.
  - Cloud Run and ECS inject Secret Manager and Secrets Manager values as environment variables.
  - On Lambda, a secret may be given as `NAME_ARN`. It's read at startup from the Secrets Manager API, with the function's own credentials (SigV4, origin-locked). Container-image functions can't use the Parameters and Secrets extension layer. `PUBLIC_URL` may be given the same way, which lets Terraform store a Lambda function URL that exists only after the function does.
- **Stores.** `CACHE_BACKEND` is `firestore` (Cloud Run), `dynamodb` (AWS), or `memory`. Both cloud stores are covered by ADR 18.
- **Health.** `/healthz` answers without a Host check, for platform health checks and the adapter's readiness check, and says nothing else. Behind CloudFront, a Lambda function URL's host can be accepted with `EXTRA_HOSTS`.
- **Logs** are JSON lines with a `severity` field, which both Cloud Logging and CloudWatch parse. Every secret is redacted.

## WHOIS over port 43

The API image keeps the WHOIS fallback (ADR 8). Platform documentation says outbound TCP is open on these targets, except where a deployer restricts it:

- **Cloud Run:** every port except 25.
- **Lambda:** open outside a VPC; inside a VPC, through a NAT gateway.
- **ECS:** as the task's security group allows.

This hasn't been verified on a live deployment. Where port 43 is blocked, extensions without RDAP report "Couldn't check", never a guess.

## Consequences

- The renderer image is about 970 MB, mostly Chromium and CJK fonts. The API image is about 180 MB.
- Two services to deploy instead of one. The Terraform modules create both.
- Not yet run on a live Cloud Run or AWS account. The guides say so, and the first real deployment should confirm the health checks, WHOIS egress, and Firestore and DynamoDB permissions.
