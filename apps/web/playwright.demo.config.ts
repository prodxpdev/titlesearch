// Records the README's demo (pnpm demo): the e2e stub server with the
// mockup's sample data, so the GIF never shows real third-party sites.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "demo",
  timeout: 120_000,
  use: {
    ...base.use,
    viewport: { width: 1280, height: 800 },
    video: { mode: "on", size: { width: 1280, height: 800 } },
  },
  outputDir: "demo/out",
  webServer: {
    ...(base.webServer as object),
    env: { E2E_PORT: "4790", E2E_DEMO_PREVIEWS: "1" },
  } as typeof base.webServer,
});
