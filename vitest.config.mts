import { defineConfig } from "vitest/config";

import namespaceTests from "./release/vite-plugin/plugin.mts";

// Two suites in one run:
//   tests/**     ordinary Vitest unit tests
//   release/**   the library's own inline `declare namespace Tests…` tests,
//                printed by the plugin from this very source tree
export default defineConfig({
  plugins: [
    namespaceTests({
      // the plugin skips its own folder when discovering tests; this repo is
      // the one place those tests should run
      scanSelf: true,
      // The fixtures carry tests of their own on purpose — the harness prints
      // them — so they are not collected here, where they would run twice.
      exclude: [
        "scratch/**",
        "reference/**",
        "tests/**",
        "release/_internal/fixtures/**",
      ],
      // The library's own modules build `ts.Program`s. Isolating them per test
      // would hold one compiler per test in memory, and they hold no mutable
      // state worth isolating, so they are shared. The fixtures are not: the
      // isolation tests depend on getting a fresh one each time.
      noIsolateModuleImport: ["release/**/*.mts"],
    }),
  ],
  test: {
    include: ["tests/**/*.test.mts"],
    // these tests build TypeScript programs and prune with the language
    // service; the 5s default is not enough for a cold run
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
