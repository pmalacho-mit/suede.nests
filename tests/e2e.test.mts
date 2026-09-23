// Runs Vitest on the deliberately wrong file and checks the reported outcome.
import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./helpers.mts";

import type { ResultRecord } from "../release/vite-plugin/reporter.mts";
import type { Warning } from "../release/vite-plugin/emit/index.mts";

/** The parts of Vitest's JSON reporter output this test reads. */
type VitestJson = {
  testResults: {
    assertionResults: {
      title: string;
      status: string;
      failureMessages: string[];
      location?: { line: number };
    }[];
  }[];
};

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));

test("scratch/failing.ts: four failures, with alias-line locations and sidecar output", () => {
  const cfg = path.join(repoRoot, "scratch/vitest.config.mts");
  const out = path.join(repoRoot, "scratch/.out");
  try {
    execFileSync("npx", ["vitest", "run", "--config", cfg], {
      // what the library writes, kept apart from the run this test is inside
      env: { ...process.env, NAMESPACE_TESTS_DIR: path.join(out, ".derived") },
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch {
    /* non-zero exit is expected */
  }
  const json = readJson(path.join(out, "vitest.json")) as VitestJson;
  const results = json.testResults[0]?.assertionResults ?? [];
  expect(results.map((r) => [r.title, r.status])).toEqual([
    ["Tests > wrong > OffByOne", "failed"],
    ["Tests > wrong > Shape", "failed"],
    ["Tests > wrong > DidNotThrow", "failed"],
    ["Tests > wrong > NotAValue", "failed"],
  ]);
  expect(results[0]?.failureMessages[0]).toContain(
    "expected 9 to deeply equal 10",
  );
  expect(results[3]?.failureMessages[0]).toContain(
    "cannot materialize `number`",
  );
  expect(results.map((r) => r.location?.line)).toEqual([9, 11, 16, 17]);

  const side = readJson(path.join(out, ".derived/results.json")) as {
    results: ResultRecord[];
  };
  expect(side.results.map((r) => r.state)).toEqual([
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  const diag = readJson(
    path.join(out, ".derived/diagnostics.json"),
  ) as Record<string, Warning[]>;
  expect(diag["scratch/failing.ts"]?.[0]?.message).toBe(
    "`number` is a type, not a value",
  );
});
