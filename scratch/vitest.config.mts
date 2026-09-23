// A config for the deliberately failing file alone. Vitest's own report goes to
// `scratch/.out/vitest.json`; what the library writes goes wherever
// `NAMESPACE_TESTS_DIR` says, which the e2e test sets so this run does not
// write over the outer one's.
import { defineConfig } from "vitest/config";
import namespaceTests from "../release/vite-plugin/plugin.mts";
import Reporter from "../release/vite-plugin/reporter.mts";

export default defineConfig({
  plugins: [namespaceTests({ scan: false, include: ["scratch/failing.ts"] })],
  test: {
    include: [],
    reporters: ["json", new Reporter()],
    outputFile: "scratch/.out/vitest.json",
  },
});
