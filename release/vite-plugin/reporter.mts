// Vitest reporter that writes `.namespace-tests/results.json`: one record per
// test with its state, errors and any display payloads recorded by ntCheck.
// The IDE extension reads this file (and diagnostics.json, written by the
// plugin at transform time) — no custom protocol.
import fs from "node:fs";
import path from "node:path";
import { encode } from "./codec.mts";

import type { Reporter, TestCase, Vitest } from "vitest/node";
import type { DisplayRecord } from "./runtime.mts";
import type { Encoded } from "./codec.mts";

/** One entry in results.json. */
export type ResultRecord = {
  id: string;
  name: string;
  fullName: string;
  /** Relative to the Vitest root. */
  file: string;
  /** Source-mapped: the `export type` line. */
  location: { line: number, column: number } | null;
  state: "passed" | "failed" | "skipped" | "pending";
  duration: number | null;
  errors: { message: string, diff: string | null, stack: string | null }[];
  displays: (Omit<DisplayRecord, "actual" | "expected"> & { actual: Encoded, expected: Encoded })[];
};

export default class NamespaceTestsReporter implements Reporter {
  outDir: string;
  results: ResultRecord[];
  root: string;

  constructor({ outDir = ".namespace-tests" }: { outDir?: string } = {}) {
    this.outDir = outDir;
    this.results = [];
    this.root = process.cwd();
  }

  onInit(ctx: Vitest) {
    this.root = ctx.config.root;
  }

  onTestCaseResult(testCase: TestCase) {
    const r = testCase.result();
    const meta = testCase.meta() as { namespaceTests?: DisplayRecord[] };
    this.results.push({
      id: testCase.id,
      name: testCase.name,
      fullName: testCase.fullName,
      file: path.relative(this.root, testCase.module.moduleId),
      location: testCase.location ?? null,
      state: r.state,
      duration: testCase.diagnostic()?.duration ?? null,
      errors: (r.errors ?? []).map((e) => ({ message: e.message, diff: e.diff ?? null, stack: e.stack ?? null })),
      displays: (meta.namespaceTests ?? []).map((d) => ({ ...d, actual: encode(d.actual), expected: encode(d.expected) })),
    });
  }

  onTestRunEnd() {
    const dir = path.join(this.root, this.outDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results: this.results }, null, 2));
  }
}
