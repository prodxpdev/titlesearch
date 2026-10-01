# 23. Desktop: a Tauri shell around the sidecar

- Status: accepted (signing, notarization, and update keys pending: see Open items)
- Date: 2026-10-01

## Context

`CLAUDE.md` asks for a thin Tauri 2 shell. It runs the compiled binary as a sidecar in `serve` mode and loads the UI in a webview, with no second implementation of any logic. Desktop-only concerns are the tray, auto-start, keychain storage, and auto-update.

## Decision

- **Sidecar.** The `titlesearch` binary (Bun-compiled, UI embedded) is bundled with `bundle.externalBin`. The shell starts it with `serve --port <free loopback port>` in desktop mode (`TITLESEARCH_DESKTOP=1`). In that mode:
  - the token comes from the shell (`TITLESEARCH_TOKEN`) instead of a file;
  - events go to stdout as JSON lines (`ready`, `code`, `token`) on a pipe only the shell reads;
  - browser sessions last 30 days, since the app belongs to one person on their own computer.
- **Signing in without a secret in a URL.** The sidecar reports a one-time login code. The shell creates the webview with an initialization script that sets it, and the UI submits it and then deletes it. Reopening a closed window asks the sidecar for a fresh code over stdin.
- **Keychain.** The local token lives in the OS keychain (service `com.prodxp.titlesearch`, account `local-token`), through the `keyring` crate.
  - `CLAUDE.md` names "the Tauri keyring plugin", but the only crate by that name (`tauri-plugin-keyring` 0.1.0) has no published repository and little use. That's too much supply-chain risk for the credential it would hold.
  - `keyring` is the library such plugins wrap. It's widely used, dual-licensed MIT/Apache-2.0, and calls the platform stores directly.
  - Replacing the token in the UI sends the new one back to the shell, which saves it.
- **Webview.** Only the local server's origin loads in the window. Any other http(s) link, or a new-window request, opens in the system browser. No Tauri IPC is exposed to the page: there are no capabilities.
- **Tray and lifecycle.**
  - The tray has Open, Start at login, Check for updates, and Quit.
  - Closing the window hides it. Quit stops the sidecar.
  - A second launch focuses the existing window (single instance).
  - Start at login uses a LaunchAgent on macOS (or the platform equivalent) with `--hidden`, so no window opens at login.
- **Updates.** `tauri-plugin-updater` checks GitHub Releases' `latest.json`, and verifies each download's signature against the public key in `tauri.conf.json` before installing. Until a release key is configured, update checks are skipped, and the menu says updates aren't set up.
- **Signing.**
  - macOS builds use the hardened runtime. The entitlements allow JIT, which Bun's JavaScript engine needs.
  - The release workflow (step 13) signs and notarizes macOS builds, and signs Windows builds, from repository secrets. None of these credentials are in the repository.

## Verified

On macOS (arm64), a debug `.app` built and launched:

- the sidecar listened on `127.0.0.1` only;
- the window opened already signed in;
- the token was created in the login keychain, and no token file was written.

`cargo clippy -D warnings` is clean. Windows and Linux builds haven't been run yet; the release workflow builds them.

## Open items

- An Apple Developer ID certificate and notarization credentials, a Windows code-signing certificate, and the updater key pair (`tauri signer generate`). Only the owner should create these. The public key goes in `tauri.conf.json`, and the private keys go in repository secrets.
