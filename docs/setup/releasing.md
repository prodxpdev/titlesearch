# Releasing

Pushing a tag such as `v1.2.3` runs [`.github/workflows/release.yml`](https://github.com/prodxpdev/titlesearch/blob/main/.github/workflows/release.yml). It builds and publishes:

- CLI binaries for macOS (arm64, x64), Windows (x64), and Linux (x64, arm64), each with a CycloneDX SBOM, plus `SHA256SUMS` and build-provenance attestations;
- the desktop app for each platform;
- the API and renderer images on GHCR, with SBOM and provenance attestations;
- the `titlesearch` npm package, with provenance;
- `server.json` to the MCP Registry.

## Cutting a release

```sh
node tools/set-version.mjs 1.2.3
(cd apps/desktop/src-tauri && cargo update -p titlesearch-desktop)
git commit -sam "Release 1.2.3" && git tag v1.2.3 && git push --follow-tags
```

The workflow fails if the tag and any manifest disagree.

## One-time setup

Signing steps run only when their secrets exist. Without them, the artifacts are published unsigned and the run shows a warning.

| What | Where |
|---|---|
| **npm.** Trusted publishing: on npmjs.com, add this repository and `release.yml` as a trusted publisher for `titlesearch`. No npm token is stored. | npm |
| **MCP Registry.** The `io.github.prodxpdev` namespace is proven by GitHub OIDC from this repository. Nothing to store. | — |
| **GHCR.** Uses the workflow's token. Make the `titlesearch-api` and `titlesearch-renderer` packages public after the first release. | GitHub |
| **macOS signing and notarization.** `APPLE_CERTIFICATE` (base64 Developer ID Application .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, and an App Store Connect API key for notarization: `APPLE_API_ISSUER`, `APPLE_API_KEY_ID`, and `APPLE_API_KEY_P8` (the .p8 file's contents). The binaries, the app, and the disk image are all notarized. `APPLE_ID` with `APPLE_PASSWORD` (an app-specific password) still works in place of the API key, but those passwords expire. Set now, with the same Developer ID as Datera. | Repository secrets |
| **Windows signing.** `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD`, `WINDOWS_CERTIFICATE_THUMBPRINT`. | Repository secrets |
| **Desktop updates.** Run `pnpm --filter @titlesearch/desktop tauri signer generate`, put the public key in `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a copy of the private key offline: without it, installed apps can't be updated. | Repository secrets |

Only the project owner should create the signing certificates and the update key.
