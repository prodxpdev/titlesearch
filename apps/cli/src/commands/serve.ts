// `titlesearch serve`: the local UI and API on 127.0.0.1 (invariant 5).

import { createInterface } from "node:readline";
import type { Logger } from "@titlesearch/core";
import {
  createApp,
  LocalAuth,
  type Settings,
  SettingsError,
  type SettingsHandler,
  type UiAssets,
} from "@titlesearch/server";
import { type CliConfig, saveConfig } from "../config.js";
import type { Runtime, RuntimeOptions } from "../runtime.js";
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

export interface ServeOptions {
  port: number;
  configDir: string;
  version: string;
  logger: Logger;
  config: CliConfig;
  runtimeOptions: Omit<RuntimeOptions, "config">;
  build: (options: RuntimeOptions) => Promise<Runtime>;
  ui?: UiAssets;
  hasAnthropicKey: boolean;
}

function toSettings(config: CliConfig, runtime: Runtime, hasKey: boolean): Settings {
  return {
    providers: {
      rdap: { enabled: true },
      godaddy: { enabled: config.providers.godaddy.enabled },
      porkbun: { enabled: false, configured: false },
      namecom: { enabled: false, configured: false },
    },
    assessment: {
      mode: runtime.services.assessment?.mode ?? "client",
      model: config.assessment.model,
      keyConfigured: hasKey,
    },
    previews: { mode: config.previews.mode, browser: runtime.browser },
    siteChecks: { timeoutSeconds: 5, maxRedirects: 3, pageKilobytes: 512, cacheHours: 6 },
  };
}

export async function runServe(options: ServeOptions): Promise<void> {
  if (typeof Bun === "undefined")
    throw new Error("`titlesearch serve` runs on Bun. Use the titlesearch binary.");

  let config = options.config;
  let runtime = await options.build({ ...options.runtimeOptions, config });
  const token = await loadOrCreateToken(options.configDir);
  const auth = new LocalAuth({ token, port: options.port });

  const settings: SettingsHandler = {
    get: () => toSettings(config, runtime, options.hasAnthropicKey),
    async update(patch) {
      const next: CliConfig = structuredClone(config);
      if (patch.providers?.godaddy)
        next.providers.godaddy.enabled = patch.providers.godaddy.enabled;
      if (patch.previews) next.previews.mode = patch.previews.mode;
      if (patch.assessment) {
        if (patch.assessment.mode === "anthropic" && !options.hasAnthropicKey) {
          throw new SettingsError("Set ANTHROPIC_API_KEY before choosing the Anthropic API.");
        }
        next.assessment.mode = patch.assessment.mode;
      }
      const rebuilt = await options.build({ ...options.runtimeOptions, config: next });
      await saveConfig(options.configDir, next);
      const old = runtime;
      config = next;
      runtime = rebuilt;
      await old.close();
      return toSettings(config, runtime, options.hasAnthropicKey);
    },
  };

  const app = createApp({
    services: () => runtime.services,
    auth,
    version: options.version,
    settings,
    rotateToken: () => rotateToken(options.configDir),
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
