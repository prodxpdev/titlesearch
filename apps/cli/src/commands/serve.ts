// `titlesearch serve`: the local UI and API on 127.0.0.1 (invariant 5).

import { createInterface } from "node:readline";
import { detectLocalRuntimes, modelUnavailable } from "@titlesearch/assess";
import type { RedactingLogger } from "@titlesearch/core";
import {
  createApp,
  KEY_NAMES,
  type KeyName,
  LocalAuth,
  type Settings,
  SettingsError,
  type SettingsHandler,
  type UiAssets,
} from "@titlesearch/server";
import { type CliConfig, saveConfig } from "../config.js";
import { type PriceKeys, priceKeysFromEnv, type Runtime, type RuntimeOptions } from "../runtime.js";
import { loadOrCreateToken, rotateToken, tokenPath } from "../token.js";

export const DEFAULT_PORT = 4717;
/** Never configurable: the local server is reachable from this computer only. */
const HOSTNAME = "127.0.0.1";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
    idleTimeout?: number;
  }): { port: number; stop(): void };
};

/**
 * Desktop mode (TITLESEARCH_DESKTOP=1): run as the Tauri app's sidecar. The
 * token comes from the app (the OS keychain) through TITLESEARCH_TOKEN instead
 * of a file. Events go to stdout as JSON lines for the app to read: "ready"
 * with a one-time login code for its webview, "code" when asked for another
 * (any line on stdin), and "token" when the user replaces the token. stdout is
 * a pipe only the app reads.
 */
export interface DesktopMode {
  token: string;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface ServeOptions {
  port: number;
  configDir: string;
  version: string;
  logger: RedactingLogger;
  config: CliConfig;
  runtimeOptions: Omit<RuntimeOptions, "config">;
  build: (options: RuntimeOptions) => Promise<Runtime>;
  ui?: UiAssets;
  /** Key values at startup, from the environment (the keychain, in the desktop app). */
  keys: Partial<Record<KeyName, string>>;
  desktop?: DesktopMode;
}

function toSettings(
  config: CliConfig,
  runtime: Runtime,
  values: Partial<Record<KeyName, string>>,
  desktop: boolean,
): Settings {
  const hasKey = !!values.ANTHROPIC_API_KEY;
  const keys: PriceKeys = priceKeysFromEnv(values);
  return {
    providers: {
      rdap: { enabled: true },
      godaddy: { enabled: config.providers.godaddy.enabled },
      porkbun: {
        enabled: !!keys.porkbun && config.providers.porkbun.enabled,
        configured: !!keys.porkbun,
      },
      namecom: {
        enabled: !!keys.namecom && config.providers.namecom.enabled,
        configured: !!keys.namecom,
      },
    },
    assessment: {
      mode: runtime.services.assessment?.mode ?? "client",
      model: {
        provider: runtime.model.choice.provider,
        id: runtime.model.choice.id,
        ...(runtime.model.choice.baseUrl ? { baseUrl: runtime.model.choice.baseUrl } : {}),
        label: runtime.model.label,
        local: runtime.model.descriptor.locality === "local",
      },
      ready: !runtime.model.unavailable,
      ...(runtime.model.unavailable ? { unavailableReason: runtime.model.unavailable } : {}),
      keyConfigured: hasKey,
    },
    suggestions: { available: !!runtime.services.suggester },
    previews: { mode: config.previews.mode, browser: runtime.browser },
    keys: {
      storage: desktop ? "keychain" : "environment",
      set: Object.fromEntries(KEY_NAMES.map((n) => [n, !!values[n]])) as Record<KeyName, boolean>,
    },
    siteChecks: { timeoutSeconds: 5, maxRedirects: 3, pageKilobytes: 512, cacheHours: 6 },
  };
}

export async function runServe(options: ServeOptions): Promise<void> {
  if (typeof Bun === "undefined")
    throw new Error("`titlesearch serve` runs on Bun. Use the titlesearch binary.");

  let config = options.config;
  // The current keys. In the desktop app, the page can change them (setKey).
  const values: Partial<Record<KeyName, string>> = { ...options.keys };
  const modelKeys = () => ({
    anthropic: values.ANTHROPIC_API_KEY,
    openaiCompatible: values.OPENAI_COMPATIBLE_API_KEY,
  });
  const build = (c: CliConfig) =>
    options.build({
      ...options.runtimeOptions,
      config: c,
      priceKeys: priceKeysFromEnv(values),
      ...(values.ANTHROPIC_API_KEY ? { anthropicApiKey: values.ANTHROPIC_API_KEY } : {}),
      ...(values.OPENAI_COMPATIBLE_API_KEY
        ? { openaiCompatibleApiKey: values.OPENAI_COMPATIBLE_API_KEY }
        : {}),
    });
  let runtime = await build(config);
  const desktop = options.desktop;
  const token = desktop ? desktop.token : await loadOrCreateToken(options.configDir);
  // The desktop app is one person's, on their own computer: its webview stays signed in.
  const auth = new LocalAuth({
    token,
    port: options.port,
    ...(desktop ? { sessionTtlMs: 30 * 24 * 60 * 60 * 1000 } : {}),
  });

  const current = () => toSettings(config, runtime, values, !!desktop);
  const apply = async (next: CliConfig) => {
    const rebuilt = await build(next);
    await saveConfig(options.configDir, next);
    const old = runtime;
    config = next;
    runtime = rebuilt;
    await old.close();
    return current();
  };
  const settings: SettingsHandler = {
    get: current,
    // This server runs on the user's machine, so its local runtimes are theirs.
    detectModels: () => detectLocalRuntimes(),
    async update(patch) {
      const keys = priceKeysFromEnv(values);
      const next: CliConfig = structuredClone(config);
      if (patch.providers?.godaddy)
        next.providers.godaddy.enabled = patch.providers.godaddy.enabled;
      if (patch.providers?.porkbun) {
        if (patch.providers.porkbun.enabled && !keys.porkbun)
          throw new SettingsError("Add both Porkbun keys first.");
        next.providers.porkbun.enabled = patch.providers.porkbun.enabled;
      }
      if (patch.providers?.namecom) {
        if (patch.providers.namecom.enabled && !keys.namecom)
          throw new SettingsError("Add your Name.com username and token first.");
        next.providers.namecom.enabled = patch.providers.namecom.enabled;
      }
      if (patch.previews) next.previews.mode = patch.previews.mode;
      if (patch.assessment?.model) next.assessment.model = patch.assessment.model;
      if (patch.assessment?.mode) next.assessment.mode = patch.assessment.mode;
      // "server" needs a model that can be used now; say what's missing instead of failing later.
      const missing = modelUnavailable(next.assessment.model, modelKeys());
      if (next.assessment.mode === "server" && missing) {
        if (patch.assessment?.mode === "server") throw new SettingsError(missing);
        next.assessment.mode = "client";
      }
      return apply(next);
    },
    // Only the desktop app keeps keys for you (in the OS keychain). The value
    // goes to the app over this process's private stdout pipe, and is
    // redacted from every log line from now on.
    ...(desktop
      ? {
          async setKey(name: KeyName, value: string | null) {
            if (value) {
              if (name !== "NAMECOM_USERNAME") options.logger.addSecrets([value]);
              values[name] = value;
            } else {
              delete values[name];
            }
            const next: CliConfig = structuredClone(config);
            // Without the key its model needs, "server" can't stay selected.
            if (
              next.assessment.mode === "server" &&
              modelUnavailable(next.assessment.model, modelKeys())
            )
              next.assessment.mode = "client";
            const result = await apply(next);
            emit({ event: "key", name, value });
            return result;
          },
        }
      : {}),
  };

  const app = createApp({
    services: () => runtime.services,
    auth,
    version: options.version,
    settings,
    rotateToken: desktop
      ? async () => {
          const next = newToken();
          emit({ event: "token", token: next });
          return next;
        }
      : () => rotateToken(options.configDir),
    logger: options.logger,
    ...(options.ui ? { ui: options.ui } : {}),
  });

  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port,
    fetch: app.fetch,
    idleTimeout: 120,
  });
  const url = `http://${HOSTNAME}:${server.port}`;
  if (desktop) {
    emit({ event: "ready", url, loginCode: auth.issueLoginCode() });
    createInterface({ input: process.stdin }).on("line", () =>
      emit({ event: "code", loginCode: auth.issueLoginCode() }),
    );
  } else {
    const showCode = () => {
      process.stdout.write(`\nOpen ${url} and enter this code: ${auth.issueLoginCode()}\n`);
      process.stdout.write(
        "It works once, for 5 minutes. Press Enter for a new code, or Ctrl+C to stop.\n",
      );
    };
    process.stdout.write(`Titlesearch is running at ${url} (this computer only).\n`);
    process.stdout.write(
      `API and MCP clients use the bearer token in ${tokenPath(options.configDir)}.\n`,
    );
    process.stdout.write(`MCP endpoint: ${url}/mcp\n`);
    showCode();
    if (process.stdin.isTTY) createInterface({ input: process.stdin }).on("line", showCode);
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await runtime.close();
}
