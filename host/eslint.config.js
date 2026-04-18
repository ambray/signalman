/**
 * ESLint flat config for signalman/host.
 *
 * Goals:
 *   - Catch real bugs (no-unused-vars where they're genuinely unused,
 *     no-constant-condition, no-implicit-any in strict spots)
 *   - Stay quiet on pragmatic test-ism (unknown casts, deliberate any,
 *     empty catches for expected throws)
 *   - Zero config burden for contributors — `npm run lint` Just Works
 *
 * Follow-up 4 of Sprint 60.7.5. Previous config was broken (missing
 * flat-config file since the ESLint 9 upgrade); `npm run lint` errored
 * immediately. Verified working: `npm run lint` exits clean on the
 * current tree.
 *
 * If you need to disable a rule for a specific file, prefer
 * `// eslint-disable-next-line <rule>` over editing this file.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores — these paths are NEVER linted.
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "output/**",
      // Generated proto bindings (if any land here later).
      "src/**/*.g.ts",
    ],
  },

  // Base ESLint recommended.
  js.configs.recommended,

  // TypeScript-eslint recommended (non-type-checked — lower friction,
  // no tsconfig.json dependency in the lint step). Opt into
  // strict-type-checked on individual files if we want deeper checks
  // later; not worth the per-file tsconfig juggling right now.
  ...tseslint.configs.recommended,

  // Project-wide rule tuning.
  {
    rules: {
      // Tests, stubs, and orchestrator glue use `unknown` casts
      // liberally when bridging between strict orchestrator types and
      // test-scoped fakes. That's deliberate — flagging every one
      // would bury real warnings.
      "@typescript-eslint/no-explicit-any": "off",

      // Prefix with `_` to deliberately ignore an unused arg/binding.
      // The base rule is too eager; retune with the `_`-prefix
      // convention shared across the codebase.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // We use `{}` as an intentional type placeholder in a few spots
      // (e.g. tool params before schema migration). Don't warn on it.
      "@typescript-eslint/no-empty-object-type": "off",

      // Dynamic imports in orchestrator.ts are `await import(...)` —
      // TSC handles them; this rule has false positives on ESM paths
      // with `.js` extensions.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Test files: loosen further. Tests do cursed things with
  // `as unknown as X` casts to bridge between fakes and strict
  // production types; that's idiomatic and not a bug.
  {
    files: ["src/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Tests frequently have expect().fail() paths where the `if`
      // check is redundant by design.
      "no-constant-condition": "off",
    },
  },
);
