import { defineConfig } from "vitest/config";

import Reporter from "../../../release/vite-plugin/reporter.mts";

export default defineConfig({
  test: { include: ["tests/fixtures/display/display.test.ts"], reporters: [new Reporter()] },
});
