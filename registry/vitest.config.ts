/**
 * Vitest coverage configuration for `@signalman/registry`.
 *
 * Coverage policy:
 *   - Repo-wide: lines / statements / functions >= 80, branches >= 70
 *     (the v0.4.0 / wave-3 gate; some legacy modules sit just above 70
 *     on branches).
 *   - WS10 (v0.5 OCI facade) scope, registry/src/oci/**: tighter
 *     80/80/80/80 per the WS10 Definition of Done locked 2026-05-16.
 *     Per-glob thresholds override the global numbers.
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
        "src/oci/**/*.ts": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        "src/pypi/**/*.ts": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        "src/nuget/**/*.ts": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
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
