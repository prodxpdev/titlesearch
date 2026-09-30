// Live contract checks against GoDaddy's MCP and the IANA RDAP bootstrap.
// Run nightly by .github/workflows/contract-canary.yml, never on PRs.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test-canary/**/*.canary.ts"],
    testTimeout: 60_000,
    retry: 1,
  },
});
