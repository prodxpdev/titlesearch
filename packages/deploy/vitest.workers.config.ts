// Runs the deploy suite inside workerd (Miniflare): the Workers target builds
// the same services and app from the same configuration.
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
