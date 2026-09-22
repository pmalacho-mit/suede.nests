// A config for the deliberately failing file alone, written where the e2e test
// reads it: `scratch/.out/vitest.json` and `scratch/.out/.namespace-tests/*`.
import { defineConfig } from "vitest/config";
import namespaceTests from "../release/vite-plugin/plugin.mts";
import Reporter from "../release/vite-plugin/reporter.mts";

const outDir = "scratch/.out/.namespace-tests";

export default defineConfig({
  plugins: [namespaceTests({ scan: false, include: ["scratch/failing.ts"], outDir })],
  test: {
    include: [],
    reporters: ["json", new Reporter({ outDir })],
    outputFile: "scratch/.out/vitest.json",
  },
});
