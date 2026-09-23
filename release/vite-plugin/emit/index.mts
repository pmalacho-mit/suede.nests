// The printer.
// Turns every `export type X = Expect<…>` within a `declare namespace` block
// into an ordinary Vitest test, in three stages:
//
//   model.mts   type node → IR: what each node means, using the type checker
//   ir.mts      the IR itself: expressions, assertions, test cases
//   print.mts   IR → Vitest source, and what each test needs from the preamble
//
// Every test comes back on its own — a top-level `test(…)` named for the
// namespace path it was written in, with each line anchored to the source line
// it came from. `render` joins them into the module the plugin appends.
import { createEmitContext } from "./context.mts";
import {
  isExportedTypeAlias,
  isTest,
  lowerAlias,
  namespaces,
} from "./model.mts";
import { allNeeds, headerLines, printTest } from "./print.mts";

import type { EmitInput, Line, Warning } from "./context.mts";
import type { EmittedTest } from "./print.mts";

export type { EmitContext, EmitInput, Line, Warning } from "./context.mts";
export type { EmittedTest, Needs } from "./print.mts";
export * from "./ir.mts";
export { createEmitContext, DSL_FILE, RUNTIME_MODULE } from "./context.mts";
export {
  allNeeds,
  headerLines,
  needsOf,
  printExpr,
  printStatement,
  printTest,
} from "./print.mts";
export {
  lowerAlias,
  lowerBody,
  lowerExpr,
  namespaces,
  testName,
} from "./model.mts";

import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";
import type {
  printHeader,
  printModule,
  testNames,
} from "../../_internal/harness.mts";

/** What `emitTests` returns. */
export type Emitted = {
  /** The generated module's preamble: the imports and helpers every test shares. */
  header: string[];
  /** One entry per test case, in source order. */
  tests: EmittedTest[];
  /** Authoring problems found while printing, across the whole file. */
  warnings: Warning[];
};

/**
 * Print the tests of one source file.
 *
 * Every `declare namespace` is looked at: a test is an exported alias that *is*
 * one — `Expect`, `Table`, `Throws`, `Given`, or any of those under a modifier —
 * so a namespace can be named after whatever it tests. A test's name is the
 * namespace path it was written in, as written.
 *
 * @param root Only look inside this namespace. Nothing is skipped without it.
 * @param runtime Specifier the generated code imports `ntCheck` from.
 */
export function emitTests(
  { program, source }: EmitInput,
  root?: string,
  runtime?: string,
): Emitted {
  const cx = createEmitContext(program, source, runtime);
  const tests: EmittedTest[] = [];
  for (const { segs, body } of namespaces(source)) {
    if (root && segs[0] !== root) continue;
    for (const stmt of body.statements)
      if (isExportedTypeAlias(stmt) && isTest(cx, stmt.type))
        tests.push(...lowerAlias(cx, stmt, segs).map(printTest));
  }
  // The header can only be written once every test has said what it needs.
  const header = tests.length
    ? headerLines(allNeeds(tests.map((t) => t.needs)), cx.runtime)
    : [];
  return { header, tests, warnings: cx.warnings };
}

declare namespace emitTests {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace add {
      export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2], [[2, 2], "=", 4]]>;
    }
    declare namespace other.nested {
      export type Deep = Expect<1, "=", 1>;
    }
    declare namespace elsewhere {
      export type AlsoATest = Expect<1, "=", 1>;
      export type NotATest = { a: 1 };
    }
  `;

  /** one entry per test case, table rows included, in source order */
  export type EveryTest = Expect<
    Invoke<typeof testNames, [Suite]>,
    "=",
    [
      "add > Simple",
      "add > Rows[0]",
      "add > Rows[1]",
      "other > nested > Deep",
      "elsewhere > AlsoATest",
    ]
  >;

  /** an exported alias that is not a test is not collected as one */
  export type OnlyTests = Expect<
    Invoke<typeof testNames, [Suite]>,
    "excludes",
    "elsewhere > NotATest"
  >;

  /** a root is a filter you opt into: with one, the rest is left alone */
  export type UnderARoot = Expect<
    Invoke<typeof testNames, [Suite, "add"]>,
    "=",
    ["add > Simple", "add > Rows[0]", "add > Rows[1]"]
  >;

  /** the module is flat: top-level tests, no describe blocks */
  export type Flat = Expect<
    Invoke<typeof printModule, [Suite]>,
    "excludes",
    "describe("
  >;

  /** and every test is in it */
  export type Rendered = Expect<
    Invoke<typeof printModule, [Suite]>,
    "includes",
    'test("other > nested > Deep", () => {'
  >;

  /** a file with no test namespace emits nothing at all */
  export type Nothing_ = Expect<
    Invoke<typeof printModule, ["const add = (a: number) => a;"]>,
    "=",
    ""
  >;

  type Plain = `
    declare namespace a { 
      export type T = Expect<1, "=", 1>; 
    }
  `;

  type ReadsFile = `
    declare namespace a { 
      export type T = Expect<FromFile<"./a.txt">, "=", "hi">; 
    }
  `;

  /** the preamble is what the tests turned out to need, and nothing when there are none */
  export type Preamble = [
    Expect<
      Invoke<typeof printHeader, [Plain]>,
      "=",
      [
        "// ───────── generated by namespace-tests; not part of your build ─────────",
        'import { test, expect } from "vitest";',
      ]
    >,
    Expect<
      Invoke<typeof printHeader, [ReadsFile]>,
      "includes",
      'import { readFileSync } from "node:fs";'
    >,
    Expect<
      Invoke<typeof printHeader, ["const add = (a: number) => a;"]>,
      "=",
      []
    >,
  ];

  type TypeOnlyImport = `
    import type { existsSync } from "node:fs";
    declare namespace a { 
      export type T = Expect<
        Invoke<typeof existsSync, ["/nowhere"]>, 
        "=", 
        false
      >; 
    }
  `;

  /** a type-only binding a test uses as a value is imported again, as a value */
  export type ValueImport = Expect<
    Invoke<typeof printHeader, [TypeOnlyImport]>,
    "includes",
    'import { existsSync as existsSync$ } from "node:fs"; // value import: the original import is type-only'
  >;
}

/** The whole generated module: the preamble, then every test, with per-line anchors. */
export function render(emitted: Emitted): {
  code: string;
  anchors: (number | null)[];
} {
  const lines: Line[] = [
    ...emitted.header.map((code) => ({ code, line: null })),
    ...emitted.tests.flatMap((t) => [{ code: "", line: null }, ...t.lines]),
  ];
  return {
    code: lines.map((l) => l.code).join("\n"),
    anchors: lines.map((l) => l.line),
  };
}
