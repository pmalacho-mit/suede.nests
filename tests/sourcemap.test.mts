import { test, expect, describe } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { transformFor, repoRoot } from "./helpers.mts";

import type { EncodedSourceMap } from "@jridgewell/trace-mapping";

/** The 1-based original line a generated position maps to. */
const originalLine = (map: EncodedSourceMap, line: number, column: number) => {
  const o = originalPositionFor(new TraceMap(map), { line, column });
  if (o.line === null) throw new Error(`no mapping for ${line}:${column}`);
  return o.line;
};

describe("source map", () => {
  test("each collected test maps to the `export type` that declares it", async () => {
    const file = "scratch/failing.ts";
    const src = fs.readFileSync(path.join(repoRoot, file), "utf8").split("\n");
    const { code, map } = await transformFor(file);
    // the module now ends in a collector: one `await import(…)` per test
    const seen: [string, string][] = [];
    code.split("\n").forEach((l, i) => {
      const m = /await import\("[^"]*\.(\w+)\.namespace\.test\.ts"\)/.exec(l);
      if (!m?.[1]) return;
      seen.push([
        m[1],
        (src[originalLine(map, i + 1, 2) - 1] ?? "").trim().split(" ").slice(0, 3).join(" "),
      ]);
    });
    expect(seen).toEqual([
      ["Tests_wrong_OffByOne", "export type OffByOne"],
      ["Tests_wrong_Shape", "export type Shape"],
      ["Tests_wrong_DidNotThrow", "export type DidNotThrow"],
      ["Tests_wrong_NotAValue", "export type NotAValue"],
    ]);
  });

  test("the module's own lines still map to themselves", async () => {
    const { map } = await transformFor("examples/counter.ts");
    expect(originalLine(map, 3, 0)).toBe(3);
  });

  test("the collector only runs when Vitest collects this very file", async () => {
    const { code } = await transformFor("examples/counter.ts");
    // `import.meta.vitest` is Vitest's own answer to that question, so a module
    // that is merely imported by another test file registers nothing
    expect(code).toContain("if (import.meta.vitest) {");
    expect(code).not.toContain('test("');
  });
});
