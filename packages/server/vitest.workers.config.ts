// Runs the server suite inside workerd (Miniflare), proving the HTTP app is
// runtime-agnostic: the same Hono app serves the Workers target (step 11).
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-22",
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
