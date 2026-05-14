/**
 * Vitest coverage configuration for `@signalman/registry`.
 *
 * Coverage policy (per WS5 milestone Definition of Done):
 *   lines ≥ 80, statements ≥ 80, functions ≥ 80, branches ≥ 70.
 *
 * Excludes mirror host's: test fixtures, compiled output, type-only
 * declarations, install scripts, generated barrels, and orchestration
 * shells covered by integration / system tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
      exclude: [
        "**/__tests__/**",
        "**/dist/**",
        "**/*.d.ts",
        "scripts/**",
        "vitest.config.ts",
        "src/cli.ts",
        "src/mcp.ts",
        "**/index.ts",
        "**/types.ts",
      ],
    },
  },
});
