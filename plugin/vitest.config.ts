// Vitest configuration for the signalman Claude Code plugin.
//
// The plugin is mostly manifest + markdown + symlinked skills, with one
// load-bearing TS test file under `__tests__/`. Run with:
//
//   cd plugin && npx vitest run
//
// `node_modules/` is a symlink into the host workspace's tree (host has
// vitest + typescript + tsx installed). No new dependencies are
// declared for the plugin itself.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // No coverage thresholds here: the manifest-validation test is a
    // shape-check, not a unit-coverage gate. Coverage requirements
    // (≥80% lines + branches per new TS file) are recorded in
    // `docs/design/v0.5-claude-plugin.md` §Coverage gate; the
    // manifest-validation test itself is the load-bearing gate for
    // this workstream per the design doc.
  },
});
