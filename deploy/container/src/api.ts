// The API container: the Hono app with deployed auth, the platform's store,
// and the remote renderer. Runs on Bun, on Cloud Run, Lambda (through the
// Lambda Web Adapter), or ECS. See docs/setup/.

import {
  createDeployedApp,
  DeployConfigError,
  deploySecrets,
  parseDeployEnv,
} from "@titlesearch/deploy";
import { nodeWhoisConnector } from "@titlesearch/providers/whois/node";
import { RemoteRenderer } from "@titlesearch/render/remote";
import pkg from "../package.json" with { type: "json" };
import { ContainerEnv } from "./config.js";
import { createJsonLogger } from "./log.js";
import { resolveSecretArns } from "./secrets.js";
import { createStore } from "./stores.js";
import { directoryUi } from "./ui.js";
import { bunWasmLoader } from "./wasm-bun.js";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): unknown;
};

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

async function main(): Promise<void> {
  const raw = await resolveSecretArns(process.env);
  const env = parseDeployEnv(raw);
  const c = ContainerEnv.parse(raw);
  const logger = createJsonLogger(env.LOG_LEVEL, deploySecrets(env));

  const renderer =
    env.RENDERER_URL && env.RENDERER_TOKEN
      ? new RemoteRenderer({
          url: env.RENDERER_URL,
          token: env.RENDERER_TOKEN,
          // Plain HTTP only to a sidecar on this host.
          ...(LOOPBACK.test(new URL(env.RENDERER_URL).origin)
            ? { httpOrigins: [new URL(env.RENDERER_URL).origin] }
            : {}),
        })
      : undefined;
  const ui = directoryUi(c.UI_DIR);
  const app = createDeployedApp(
    env,
    {
      whois: nodeWhoisConnector,
      store: createStore(c, raw),
      ...(renderer ? { renderer } : {}),
      wasm: bunWasmLoader,
      logger,
    },
    { version: pkg.version, ...(ui ? { ui } : {}) },
  );
  Bun.serve({ hostname: "0.0.0.0", port: c.PORT, fetch: app.fetch });
  logger.info("Titlesearch is serving", {
    port: c.PORT,
    store: c.CACHE_BACKEND,
    previews: renderer ? "renderer" : "share images",
    ui: !!ui,
  });
}

main().catch((err) => {
  // Configuration errors name the setting, never its value.
  const message =
    err instanceof DeployConfigError ? err.message : `Startup failed: ${(err as Error).message}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
