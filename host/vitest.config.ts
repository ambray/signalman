// vitest configuration with coverage wiring (P7 follow-up).
//
// Run `npm run coverage` to produce a text/HTML/lcov report. The HTML
// report lands in `host/coverage/index.html`; lcov goes to
// `host/coverage/lcov.info` for IDE integration / Codecov uploads.
//
// Threshold policy (P7 baseline, captured 2026-04-25):
//
//     Lines      63.88 %    (target 80%)
//     Branches   81.15 %    (target 70%, currently MET)
//     Functions  80.60 %    (target 80%, currently MET)
//     Statements 63.88 %    (target 80%)
//
// The target thresholds are below as a comment. We do NOT enforce
// them yet — the host CLI surface (`cli.ts`, `server.ts`,
// `runner.ts`, the hyperv/selector indirection) is exercised in
// integration tests that don't run under unit-test coverage, so the
// raw line/statement number is artificially low. P8 will tighten
// either by adding direct tests for those modules, by excluding the
// integration-only entrypoints, or by both. Until then CI runs the
// report with `continue-on-error: true` so the metric is visible
// without blocking merges.
//
// To enable enforcement once the suite catches up, uncomment the
// `thresholds` block below. Vitest then exits non-zero on any
// shortfall.
//
// Excludes:
//   - **/__tests__/**   — test fixture/helper trees, not product code
//   - **/dist/**        — compiled output
//   - **/*.d.ts         — type-only declarations
//   - scripts/**        — operator/install scripts; not loaded by the
//                          MCP server runtime
//   - vitest.config.ts  — the config itself
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // P7 target — re-enable after coverage catches up:
      // thresholds: {
      //   lines: 80,
      //   functions: 80,
      //   branches: 70,
      //   statements: 80,
      // },
      exclude: [
        "**/__tests__/**",
        "**/dist/**",
        "**/*.d.ts",
        "scripts/**",
        "vitest.config.ts",
      ],
    },
  },
});
