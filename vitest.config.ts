import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Pure type/interface module — erased at compile time, so it has no
      // runtime code to execute and is never imported at runtime (consumers
      // use it as a type only). Excluded so it doesn't show a spurious 0%.
      exclude: ["src/core/aggregation/coverageProvider.ts"],
      reporter: ["text", "json"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
