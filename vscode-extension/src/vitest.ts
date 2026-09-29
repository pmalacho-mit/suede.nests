import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as vscode from "vscode";

import { testFilter } from "../../test-names.mts";
import { folderOf } from "./editor.js";
import { findLibrary } from "./library.js";
import { exec } from "./process.js";

import type { ResultRecord } from "../../vite-plugin/reporter.mts";

export type Assertion = { title: string; status: string; failureMessages?: string[] };

export type Recorded = ResultRecord["displays"][number];

export type Detail = {
  message: string;
  diff: string | null;
  where: string | null;
  stack: string | null;
  display: Recorded | null;
};

export type Report = { assertions: Assertion[]; details: Map<string, Detail> };

export type Shown = Recorded & { passed: boolean; message: string | null };

const detailOf = (record: ResultRecord): Detail | null => {
  const error = record.errors[0];
  const display = record.displays[0] ?? null;
  if (!error && !display) return null;
  return {
    message: error?.message ?? "",
    diff: error?.diff ?? null,
    where: record.location ? `${record.file}:${record.location.line}` : null,
    stack: error?.stack ?? null,
    display,
  };
};

const recordsIn = (file: string): ResultRecord[] => {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { results?: ResultRecord[] })
      .results ?? [];
  } catch {
    return [];
  }
};

function detailsFrom(file: string | null): Map<string, Detail> {
  const details = new Map<string, Detail>();
  for (const record of file ? recordsIn(file) : []) {
    const detail = detailOf(record);
    if (detail) details.set(record.name, detail);
  }
  return details;
}

const assertionsIn = (file: string): Assertion[] => {
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
    testResults?: { assertionResults?: Assertion[] }[];
  };
  return (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
};

const temporaryReport = () =>
  path.join(
    os.tmpdir(),
    `namespace-tests-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

export async function vitest(
  uri: vscode.Uri,
  only: string | undefined,
  output: vscode.OutputChannel,
): Promise<Report> {
  const cwd = folderOf(uri);
  const outputFile = temporaryReport();
  const library = findLibrary(cwd);
  const sidecar = library ? path.join(library.derived, "results.json") : null;
  if (sidecar) fs.rmSync(sidecar, { force: true });

  const args = [
    "vitest",
    "run",
    path.relative(cwd, uri.fsPath),
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...(library ? [`--reporter=${library.reporter}`] : []),
    ...(only ? ["-t", testFilter(only)] : []),
  ];
  const result = await exec("npx", args, cwd);
  if (!fs.existsSync(outputFile)) {
    output.appendLine(`npx ${args.join(" ")}`);
    output.appendLine(result.stderr || result.stdout);
    throw new Error("Vitest produced no report");
  }
  try {
    return { assertions: assertionsIn(outputFile), details: detailsFrom(sidecar) };
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
}

// a table's rows are several assertions: the first with a page is the one shown
export function shownOnPage({ details }: Report, assertions: Assertion[]): Shown | null {
  for (const assertion of assertions) {
    const detail = details.get(assertion.title);
    if (detail?.display)
      return {
        ...detail.display,
        passed: assertion.status === "passed",
        message: detail.message || null,
      };
  }
  return null;
}
