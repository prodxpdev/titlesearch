# 18. Cloud cache stores: D1, Firestore, and DynamoDB

- Status: accepted
- Date: 2026-10-01

## Context

Each deploy target needs a `CacheStore` and `BlobStore` that pass the shared conformance suite (ADR 10): D1 on Workers, Firestore on Cloud Run, and DynamoDB on AWS. The container image runs on Bun, and the stores must not pull in heavy SDKs or Node built-ins, or break the "fixed origins only" rule for outbound requests.

## Decision

- **D1** (`@titlesearch/cache/d1`) uses the SQLite store's schema over D1's async API. It creates the schema on first use; the same SQL ships as a Wrangler migration. Its conformance suite runs inside workerd (`pnpm test:workers`).
- **Firestore** (`@titlesearch/cache/firestore`) uses the REST API, and only two POST methods: `:commit` and `:batchGet`. Access tokens come from the metadata server on Cloud Run.
- **DynamoDB** (`@titlesearch/cache/dynamodb`) uses the JSON API with SigV4 signing. The signing comes from `aws4fetch`'s `AwsV4Signer`, which is small, uses Web Crypto, and is MIT-licensed; its own fetch isn't used. Credentials come from the environment (Lambda) or the ECS task-role endpoint.
- **Outbound requests.** Every request goes through `createOriginFetch`. It gained an explicit `httpOrigins` list for plain-HTTP fixed endpoints: the GCP metadata server, the ECS credentials endpoint, and local emulators. Each one is named in code or deploy config, never derived from user input.
- **Document and item keys** are SHA-256 hashes of the cache key, with the key stored and compared on read. Cache keys may contain `/` and can exceed Firestore's 1500-byte document-ID limit and DynamoDB's 2048-byte partition-key limit.
- **Blobs are chunked.** Firestore documents are limited to 1 MiB and DynamoDB items to 400 KB, while preview blobs may be up to 1 MB. A blob's chunks and its metadata are written in one atomic operation (a Firestore commit, or DynamoDB `TransactWriteItems`) under a fresh generation ID, so a reader never mixes an old and a new image.
- **Expiry** is exact on read (`expiresAt`, in milliseconds). Cleanup is left to each platform's TTL feature: the Firestore TTL policy on `expireAt`, and DynamoDB TTL on `ttl`. Terraform configures both.
- **CI** runs the Firestore and DynamoDB suites against their emulators, using images pinned by digest. In that job a missing emulator fails the run rather than skipping it.

## Consequences

- Orphaned blob chunks from overwrites remain until TTL cleanup removes them, within about a day on both platforms.
- The emulators don't check IAM. Production permissions are covered by the Terraform modules and the setup guides.
