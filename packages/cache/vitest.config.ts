import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // conformance.ts is a suite other test files run, not a test file itself.
    include: ["test/**/*.test.ts"],
  },
});
