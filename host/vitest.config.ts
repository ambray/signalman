// vitest configuration with coverage wiring (P7 follow-up).
//
// Run `npm run coverage` to produce a text/HTML/lcov report. The HTML
// report lands in `host/coverage/index.html`; lcov goes to
// `host/coverage/lcov.info` for IDE integration / Codecov uploads.
//
// Coverage policy:
//   - The unit-testable host core is held to 80% line/statement/function
//     coverage.
//   - CLI/MCP entrypoints, provider adapters, generated barrels/types,
//     and orchestration shells remain covered by integration/E2E lanes,
//     so they are excluded from the unit coverage denominator here.
//
// Excludes:
//   - **/__tests__/**   - test fixture/helper trees, not product code
//   - **/dist/**        - compiled output
//   - **/*.d.ts         - type-only declarations
//   - scripts/**        - operator/install scripts; not loaded by the
//                         MCP server runtime
//   - vitest.config.ts  - the config itself
//   - cli/server/tools/hypervisor/guest-client/orchestrator shells -
//                         integration-covered surfaces
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
        "eslint.config.js",
        "src/cli.ts",
        "src/server.ts",
        "src/guest/client.ts",
        "src/hypervisors/**",
        "src/tools/**",
        "src/scenarios/orchestrator.ts",
        "src/scenarios/runner.ts",
        "src/verbs/default-executor.ts",
        "**/index.ts",
        "**/types.ts",
      ],
    },
  },
});
