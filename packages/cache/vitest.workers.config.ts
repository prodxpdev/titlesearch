// Runs the D1 store's conformance suites inside workerd (Miniflare).
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-22",
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["test-workers/**/*.test.ts"],
  },
});
