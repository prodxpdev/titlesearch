// Installs, runs, and removes the built-in model (ADR 26).
//
// Install: the pinned llama.cpp server for this platform, then the chosen
// model's weights, each streamed to disk and verified against its pin.
// Run: on first use, `llama-server` starts on a free 127.0.0.1 port with a
// random API key (so nothing else on this computer can use it), and stops
// after a while unused, or when Titlesearch exits. Requests go through the
// same OpenAI-compatible client as any other open model.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { BUILTIN_MODELS, type BuiltinRuntime, builtinModel } from "@titlesearch/assess";
import { createOriginFetch, type Logger, silentLogger, type Transport } from "@titlesearch/core";
import { DownloadError, downloadPinned } from "./download.js";
import { DOWNLOAD_ORIGINS, LLAMA_BUILDS, LLAMA_RELEASE, type LlamaBuild } from "./llama.js";

export type BuiltinState = "not_installed" | "downloading" | "installed" | "failed";

export interface BuiltinModelStatus {
  id: string;
  label: string;
  summary: string;
  size: number;
  memoryGb: number;
  license: string;
  state: BuiltinState;
  /** While downloading: bytes so far and in all, counting the llama.cpp server if it's needed too. */
  received?: number;
  total?: number;
  /** Why the last download failed. */
  error?: string;
}

export interface BuiltinStatus {
  /** False where there's no pinned llama.cpp build for this platform. */
  supported: boolean;
  models: BuiltinModelStatus[];
}

export interface BuiltinManagerOptions {
  dataDir: string;
  logger?: Logger;
  platform?: string;
  /** Tests only. */
  transport?: Transport;
  /** Stop the server after this long unused. */
  idleMs?: number;
}

interface Running {
  modelId: string;
  child: ChildProcess;
  baseUrl: string;
  apiKey: string;
}

const START_TIMEOUT_MS = 180_000;
const CONTEXT_TOKENS = 8192;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("No free port."))));
    });
  });
}

function extract(archive: string, kind: LlamaBuild["archive"], dir: string): Promise<void> {
  // bsdtar (macOS, Windows 10+) reads zip as well as tar.gz.
  const args = kind === "zip" ? ["-xf", archive, "-C", dir] : ["-xzf", archive, "-C", dir];
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export class BuiltinManager implements BuiltinRuntime {
  readonly #dataDir: string;
  readonly #logger: Logger;
  readonly #platform: string;
  readonly #transport: Transport | undefined;
  readonly #idleMs: number;
  readonly #downloads = new Map<
    string,
    { promise: Promise<void>; received: number; total: number; controller: AbortController }
  >();
  readonly #failures = new Map<string, string>();
  #running: Running | undefined;
  #starting: Promise<Running> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BuiltinManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#logger = options.logger ?? silentLogger;
    this.#platform = options.platform ?? `${process.platform}-${process.arch}`;
    this.#transport = options.transport;
    this.#idleMs = options.idleMs ?? 10 * 60 * 1000;
    // Never leave a model server running behind us.
    process.once("exit", () => this.#running?.child.kill());
  }

  get build(): LlamaBuild | undefined {
    return LLAMA_BUILDS[this.#platform];
  }

  get #llamaDir(): string {
    return join(this.#dataDir, "llama", LLAMA_RELEASE);
  }

  #executable(): string | undefined {
    const build = this.build;
    if (!build) return undefined;
    const exe = join(this.#llamaDir, build.executable);
    return existsSync(join(this.#llamaDir, ".verified")) && existsSync(exe) ? exe : undefined;
  }

  modelPath(id: string): string | undefined {
    const model = builtinModel(id);
    return model ? join(this.#dataDir, "models", model.file) : undefined;
  }

  installed(id: string): boolean {
    const path = this.modelPath(id);
    return !!path && existsSync(path) && !!this.#executable();
  }

  unavailable(id: string): string | undefined {
    const model = builtinModel(id);
    if (!model) return `"${id}" isn't one of the built-in models.`;
    if (!this.build) return `The built-in model isn't available for ${this.#platform}.`;
    if (this.#downloads.has(id)) return `${model.label} is still downloading.`;
    if (!this.installed(id)) return `Download ${model.label} first.`;
    return undefined;
  }

  status(): BuiltinStatus {
    return {
      supported: !!this.build,
      models: BUILTIN_MODELS.map((m) => {
        const download = this.#downloads.get(m.id);
        const failure = this.#failures.get(m.id);
        const state: BuiltinState = download
          ? "downloading"
          : this.installed(m.id)
            ? "installed"
            : failure
              ? "failed"
              : "not_installed";
        return {
          id: m.id,
          label: m.label,
          summary: m.summary,
          size: m.size,
          memoryGb: m.memoryGb,
          license: m.license,
          state,
          ...(download ? { received: download.received, total: download.total } : {}),
          ...(state === "failed" && failure ? { error: failure } : {}),
        };
      }),
    };
  }

  /**
   * Downloads the server (if needed) and the model, verified. Resolves when
   * done; a second call while downloading joins the first.
   */
  install(id: string, onProgress?: (received: number, total: number) => void): Promise<void> {
    const model = builtinModel(id);
    if (!model) return Promise.reject(new Error(`"${id}" isn't one of the built-in models.`));
    const build = this.build;
    if (!build)
      return Promise.reject(new Error(`The built-in model isn't available for ${this.#platform}.`));
    const existing = this.#downloads.get(id);
    if (existing) return existing.promise;
    if (this.installed(id)) return Promise.resolve();

    const needsServer = !this.#executable();
    const entry = {
      received: 0,
      total: model.size + (needsServer ? build.size : 0),
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    const report = (received: number) => {
      entry.received = received;
      onProgress?.(received, entry.total);
    };
    this.#failures.delete(id);
    entry.promise = (async () => {
      try {
        let offset = 0;
        if (needsServer) {
          await this.#installServer(build, (n) => report(n), entry.controller.signal);
          offset = build.size;
        }
        const dir = join(this.#dataDir, "models");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await downloadPinned(model, join(dir, model.file), {
          ...DOWNLOAD_ORIGINS.model,
          onProgress: (n) => report(offset + n),
          signal: entry.controller.signal,
          ...(this.#transport ? { transport: this.#transport } : {}),
        });
        this.#logger.info("Built-in model installed", { model: id });
      } catch (err) {
        const message =
          err instanceof DownloadError || err instanceof Error ? err.message : String(err);
        this.#failures.set(id, entry.controller.signal.aborted ? "Download canceled." : message);
        throw err;
      } finally {
        this.#downloads.delete(id);
      }
    })();
    this.#downloads.set(id, entry);
    return entry.promise;
  }

  async #installServer(
    build: LlamaBuild,
    onProgress: (received: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const dir = this.#llamaDir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const archive = join(dir, `download.${build.archive}`);
    await downloadPinned(build, archive, {
      ...DOWNLOAD_ORIGINS.llama,
      onProgress,
      signal,
      ...(this.#transport ? { transport: this.#transport } : {}),
    });
    try {
      await extract(archive, build.archive, dir);
      await rm(archive, { force: true });
      const exe = join(dir, build.executable);
      if (!existsSync(exe)) throw new Error("The archive didn't contain llama-server.");
      if (process.platform !== "win32") await chmod(exe, 0o755);
      await writeFile(join(dir, ".verified"), `${build.sha256}\n`);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`Couldn't unpack the llama.cpp server: ${(err as Error).message}`);
    }
  }

  /** Stops a download in progress. Its partial file stays, so a retry resumes. */
  cancel(id: string): void {
    this.#downloads.get(id)?.controller.abort();
  }

  /** Deletes a model's weights. The llama.cpp server stays: it's small and shared. */
  async remove(id: string): Promise<void> {
    const path = this.modelPath(id);
    if (!path) throw new Error(`"${id}" isn't one of the built-in models.`);
    this.cancel(id);
    await this.#downloads.get(id)?.promise.catch(() => {});
    if (this.#running?.modelId === id) this.#stop();
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
    this.#failures.delete(id);
  }

  async start(id: string, signal?: AbortSignal): Promise<{ baseUrl: string; apiKey: string }> {
    const reason = this.unavailable(id);
    if (reason) throw new Error(reason);
    if (this.#running?.modelId !== id || this.#running.child.exitCode !== null) {
      if (!this.#starting) {
        this.#stop();
        this.#starting = this.#spawn(id).finally(() => {
          this.#starting = undefined;
        });
      }
      const started = this.#starting;
      // Waiting can be canceled; the start itself carries on for the next caller.
      this.#running = signal
        ? await Promise.race([
            started,
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              if (signal.aborted) reject(signal.reason);
            }),
          ])
        : await started;
      if (this.#running.modelId !== id) return this.start(id, signal);
    }
    this.#touch();
    return { baseUrl: this.#running.baseUrl, apiKey: this.#running.apiKey };
  }

  async #spawn(id: string): Promise<Running> {
    const exe = this.#executable();
    const model = this.modelPath(id);
    if (!exe || !model) throw new Error("The built-in model isn't installed.");
    const port = await freePort();
    const apiKey = randomKey();
    const baseUrl = `http://127.0.0.1:${port}`;
    const args = [
      ...["-m", model, "--host", "127.0.0.1", "--port", String(port)],
      ...["-c", String(CONTEXT_TOKENS), "-np", "1", "--jinja", "--no-webui", "--offline"],
    ];
    this.#logger.info("Starting the built-in model", { model: id, port });
    // The key goes through the environment, not the command line, so other
    // users of this computer can't read it from the process list.
    const child = spawn(exe, args, {
      cwd: join(exe, ".."),
      env: { ...process.env, LLAMA_API_KEY: apiKey },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    });
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        const last = tail.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        reject(new Error(`llama-server exited (${code})${last ? `: ${last}` : ""}`));
      });
    });
    exited.catch(() => {});
    child.once("exit", () => {
      if (this.#running?.child === child) this.#running = undefined;
    });

    const health = createOriginFetch({
      origins: [],
      httpOrigins: [baseUrl],
      timeoutMs: 2000,
      maxBytes: 64 * 1024,
      ...(this.#transport ? { transport: this.#transport } : {}),
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    const ready = (async () => {
      // 503 while the model loads, 200 once it can answer.
      while (Date.now() < deadline) {
        try {
          if ((await health(`${baseUrl}/health`)).ok) return;
        } catch {
          // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("The built-in model took too long to load.");
    })();
    try {
      await Promise.race([ready, exited]);
    } catch (err) {
      child.kill();
      throw err;
    }
    return { modelId: id, child, baseUrl, apiKey };
  }

  #touch(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#stop(), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #stop(): void {
    clearTimeout(this.#idleTimer);
    const running = this.#running;
    this.#running = undefined;
    if (running && running.child.exitCode === null) {
      this.#logger.info("Stopping the built-in model", { model: running.modelId });
      running.child.kill();
    }
  }

  /** Stops the server and any downloads. Partial downloads stay to resume. */
  async close(): Promise<void> {
    for (const d of this.#downloads.values()) d.controller.abort();
    this.#stop();
  }
}
