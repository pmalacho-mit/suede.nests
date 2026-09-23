import { defineConfig } from "vitest/config";

import namespaceTests from "./release/vite-plugin/plugin.mts";

// Two suites in one run:
//   tests/**     ordinary Vitest unit tests
//   release/**   the library's own inline `declare namespace Tests…` tests,
//                printed by the plugin from this very source tree
export default defineConfig({
  plugins: [
    namespaceTests({
      _scanSelf: true,
      exclude: ["scratch/**", "tests/**", "release/_internal/fixtures/**"],
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
