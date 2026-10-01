// The renderer container: headless Chromium behind the egress proxy, served to
// the API over HTTP with a shared token. It has no credentials and no access
// to the cache (invariant 8). Deploy it as its own service, with an identity
// that has no permissions. See docs/decisions/0020-container-deploy.md.

import { DohResolver } from "@titlesearch/core";
import { createRenderService, LocalChromiumRenderer } from "@titlesearch/render";
import { RendererEnv } from "./config.js";
import { createJsonLogger } from "./log.js";

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): unknown;
};

const env = RendererEnv.safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    `${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")}\n`,
  );
  process.exit(1);
}
const logger = createJsonLogger(env.data.LOG_LEVEL, [env.data.RENDERER_TOKEN]);
const renderer = new LocalChromiumRenderer({
  executablePath: env.data.CHROMIUM_PATH,
  resolver: new DohResolver(),
  concurrency: env.data.RENDER_CONCURRENCY,
  // The container (gVisor on Cloud Run, Firecracker on Lambda) is the sandbox here:
  // Chromium's own needs user namespaces these platforms don't offer.
  noSandbox: true,
  logger,
});
Bun.serve({
  hostname: "0.0.0.0",
  port: env.data.PORT,
  fetch: createRenderService({ renderer, token: env.data.RENDERER_TOKEN, logger }),
});
logger.info("Renderer is serving", { port: env.data.PORT });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => void renderer.close().finally(() => process.exit(0)));
