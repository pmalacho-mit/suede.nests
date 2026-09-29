import fs from "node:fs";
import path from "node:path";
import { ensureDerived } from "./cache.mts";
import { encode } from "./codec.mts";
import { recordedFor, type DisplayRecord } from "./runtime.mts";

import type { Reporter, TestCase, Vitest } from "vitest/node";
import type { Encoded } from "./codec.mts";

type EncodedDisplay = Omit<DisplayRecord, "actual" | "expected"> & {
  actual: Encoded;
  expected: Encoded;
};

type RecordedError = { message: string; diff: string | null; stack: string | null };

export type ResultRecord = {
  id: string;
  name: string;
  fullName: string;
  file: string;
  // source-mapped to the `export type` the test was written as
  location: { line: number; column: number } | null;
  state: "passed" | "failed" | "skipped" | "pending";
  duration: number | null;
  errors: RecordedError[];
  displays: EncodedDisplay[];
};

const recordedError = ({ message, diff, stack }: { message: string; diff?: string; stack?: string }): RecordedError => ({
  message,
  diff: diff ?? null,
  stack: stack ?? null,
});

const encodedDisplay = (display: DisplayRecord): EncodedDisplay => ({
  ...display,
  actual: encode(display.actual),
  expected: encode(display.expected),
});

export default class NamespaceTestsReporter implements Reporter {
  results: ResultRecord[] = [];
  root = process.cwd();

  onInit(ctx: Vitest) {
    this.root = ctx.config.root;
  }

  onTestCaseResult(testCase: TestCase) {
    const result = testCase.result();
    this.results.push({
      id: testCase.id,
      name: testCase.name,
      fullName: testCase.fullName,
      file: path.relative(this.root, testCase.module.moduleId),
      location: testCase.location ?? null,
      state: result.state,
      duration: testCase.diagnostic()?.duration ?? null,
      errors: (result.errors ?? []).map(recordedError),
      displays: recordedFor({ meta: testCase.meta() }).map(encodedDisplay),
    });
  }

  onTestRunEnd() {
    fs.writeFileSync(
      path.join(ensureDerived(), "results.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), results: this.results }, null, 2),
    );
  }
}
