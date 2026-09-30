// Runs the same core suites inside workerd (Miniflare), so the SSRF checks and
// URL canonicalization are proven on the Workers runtime too.
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
