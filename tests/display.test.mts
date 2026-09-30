// Runs Vitest on tests that record display values, and reads what the reporter wrote.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";

import { decode } from "../release/vite-plugin/codec.mts";
import { repoRoot } from "./helpers.mts";

import type { ResultRecord } from "../release/vite-plugin/reporter.mts";

const derived = path.join(repoRoot, "tests/fixtures/display/.derived");
let records: ResultRecord[] = [];

beforeAll(() => {
  fs.rmSync(derived, { recursive: true, force: true });
  execFileSync("npx", ["vitest", "run", "--config", "tests/fixtures/display/vitest.config.mts"], {
    // what the library writes, kept apart from the run this test is inside
    env: { ...process.env, NAMESPACE_TESTS_DIR: derived },
    cwd: repoRoot,
    stdio: "pipe",
  });
  records = (JSON.parse(fs.readFileSync(path.join(derived, "results.json"), "utf8")) as { results: ResultRecord[] }).results;
  fs.rmSync(derived, { recursive: true, force: true });
});

test("a display is recorded as an artifact, with values JSON alone could not carry", () => {
  const [display] = records.find((r) => r.name === "rich values")!.displays;
  expect(display).toMatchObject({ type: "namespace-tests:display", page: "./page.html", location: { line: 13 } });
  expect(decode(display!.actual)).toEqual({ counts: new Map([["a", 1n]]), point: { x: 1 }, bytes: new Uint8Array([1, 2]) });
  expect(decode(display!.meta)).toEqual({ bins: 4 });
});

test("a function among the values is recorded, rather than failing the run", () => {
  const function_ = records.find((r) => r.name === "a function");
  expect(function_?.state).toBe("passed");
  expect(function_?.displays[0]?.actual).toEqual({ $type: "function", name: null });
});
