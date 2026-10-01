# syntax=docker/dockerfile:1.7
#
# Two images from one build (context: the repository root):
#
#   docker build -f deploy/container/Dockerfile --target api      -t titlesearch-api .
#   docker build -f deploy/container/Dockerfile --target renderer -t titlesearch-renderer .
#
# api:      Cloud Run, AWS Lambda (through the Lambda Web Adapter), or ECS.
# renderer: the separate preview service. Deploy it with an identity that has
#           no permissions (invariant 8). See docs/setup/.
#
# Base images are pinned by digest; Renovate updates them.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG LAMBDA_ADAPTER_IMAGE=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0@sha256:b4da35991627bdac98a81c377d0cc28e6989687359576dfda9f0b64be835d648

FROM ${LAMBDA_ADAPTER_IMAGE} AS lambda-adapter

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @titlesearch/web build \
 && npx --yes bun@1.4.2 build --compile deploy/container/src/api.ts --outfile /out/titlesearch-api \
 && npx --yes bun@1.4.2 build --compile deploy/container/src/renderer.ts --outfile /out/titlesearch-renderer \
 && cp -r apps/web/dist /out/ui

# The pinned, checksum-verified Chromium for the renderer.
FROM build AS chromium
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
 && npx --yes bun@1.4.2 deploy/container/src/install-chromium.ts /opt/chromium \
 && chmod -R a+rX /opt/chromium

FROM ${RUNTIME_IMAGE} AS api
COPY --from=lambda-adapter /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=build /out/titlesearch-api /app/titlesearch-api
COPY --from=build /out/ui /app/ui
ENV PORT=8080 \
    UI_DIR=/app/ui \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/healthz
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/titlesearch-api"]

FROM ${DEBIAN_IMAGE} AS renderer
# Chromium's shared libraries and fonts that cover most scripts and emoji.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libdbus-1-3 libexpat1 \
      fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin renderer
COPY --from=chromium /opt/chromium /opt/chromium
COPY --from=build /out/titlesearch-renderer /app/titlesearch-renderer
ENV PORT=8080 CHROMIUM_PATH=/opt/chromium/chrome-headless-shell
USER renderer
EXPOSE 8080
ENTRYPOINT ["/app/titlesearch-renderer"]
