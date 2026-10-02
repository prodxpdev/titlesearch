# 26. The built-in model: downloaded after install, run by a pinned llama.cpp server

- Status: accepted
- Date: 2026-10-01

## Context

ADR 25 let the server's model be an open model in Ollama or LM Studio. That still asks people to install and manage a second app. Datera bundles a model in its installer. Doing that here would add gigabytes to every download, including for people who use Claude or no model at all, and the engine (a `bun build --compile` binary) can't load `node-llama-cpp`'s native addons reliably on every platform.

## Decision

- **Download after install, on request.** The Providers page (or `titlesearch models install [id]`) downloads two things into the data directory:
  - a pinned llama.cpp release's `llama-server` for this platform, from GitHub (`llama/<release>/`);
  - one model's GGUF weights, from Hugging Face (`models/<file>`).
  
  Nothing is downloaded until someone asks, and the installers stay the size they were.
- **Pinned, then verified.**
  - Weights are pinned by repository commit, size, and SHA-256 (`packages/assess/src/builtin-catalog.ts`).
  - llama.cpp builds are pinned by release and the SHA-256 GitHub publishes for each asset (`apps/cli/src/builtin/llama.ts`).
  - Files stream to `<name>.part` and are hashed as they're written, so multi-gigabyte files never sit in memory. They get their final names only when size and hash match. An interrupted download resumes with a `Range` request after re-hashing what's there.
- **Allowed hosts.** Downloads go through `createOriginStream` in core: `github.com` and `huggingface.co`, plus HTTPS hosts under `.githubusercontent.com` and `.hf.co` on the default port, because their CDN hostnames vary by region. That allowance is only for pinned downloads; the checksum, not the host, is what's trusted.
- **The models.** Instruction-tuned, Apache-2.0, Q4_K_M:
  - Qwen2.5 1.5B Instruct (1.1 GB);
  - Qwen3 4B Instruct 2507 (2.5 GB, the default);
  - Qwen2.5 7B Instruct (4.7 GB).
  
  Qwen3 4B Instruct 2507 is a non-thinking model, so it answers directly. It holds up well on structured judgments for its size.
- **Running it.**
  - `llama-server` starts on first use, on `127.0.0.1` and a free port, with an 8,192-token context, one slot, `--offline`, and no web UI.
  - A random API key goes to it through `LLAMA_API_KEY` in its environment, not its command line, so nothing else on this computer can use it, and other users can't read the key from the process list.
  - Titlesearch waits for `/health`, then talks to it through the same `OpenAICompatibleJsonModel` as any other open model. llama.cpp turns the JSON Schema in `response_format` into a grammar, so answers are well-formed JSON. They're still validated strictly.
  - It stops after 10 minutes unused, when another built-in model is chosen, when its weights are removed, and when Titlesearch exits. The desktop app asks the sidecar to quit (a `quit` line on its stdin) before killing it, so the model server never outlives the app.
- **Where it's offered.** The desktop app and the `titlesearch` command. Deployed servers don't offer it: `ASSESSMENT_PROVIDER` rejects `builtin`, and the server has no `/api/models/builtin` routes there.
- **Same safety as every model.** Site text is delimited untrusted data in the prompt. Anything that doesn't validate leaves sites unassessed and suggestions unoffered.

## Consequences

- Choosing the built-in model costs a one-time download of 1.2 to 4.7 GB, and memory while it runs. The picker says both.
- Moving to a newer llama.cpp or model means updating its pins: release and SHA-256 for each of the five platform builds, and commit, size, and SHA-256 for a model. Tests check the shape of every pin.
- The CPU builds are used on Linux and Windows (Metal is used on Apple Silicon). That's slower than a GPU build, but it runs everywhere without driver requirements.
