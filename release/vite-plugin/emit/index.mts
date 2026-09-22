// The printer.
// Turns every `export type X = Expect<…>` within a `declare namespace Tests…`
// block into an ordinary Vitest test.
//
// There is no IR: a TypeScript *type* literal is printed as the equivalent
// *value* literal, `Invoke<typeof f, [a]>` prints as `await f(a)`, and each
// DSL condition maps onto a built-in `expect` matcher.
//
// Every test comes back on its own — a top-level `test(…)` named for the
// namespace path it was written in, with each line anchored to the source line
// it came from. `render` joins them into the module the plugin appends.
//
// The pipeline, each stage in its own module:
//   context.mts     the shared state (`cx`) every stage threads through
//   expression.mts  type node  → JS expression
//   assertion.mts   condition  → `expect` chain, Test node → statements
//   suite.mts       test alias → one `EmittedTest` per test case
//   header.mts      the generated module's preamble
import ts from "typescript";

import { asEmitContext } from "./context.mts";
import { headerLines } from "./header.mts";
import { emitTestAlias, isTest, namespaces } from "./suite.mts";

import type { EmitInputOrContext, Line, Warning } from "./context.mts";
import type { EmittedTest } from "./suite.mts";

export { createEmitContext, DSL_FILE, freshTestState } from "./context.mts";
export * from "./assertion.mts";
export * from "./context.mts";
export * from "./expression.mts";
export * from "./header.mts";
export * from "./suite.mts";

import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";
import type { printModule, testNames } from "../../_internal/harness.mts";
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
  inputOrContext: EmitInputOrContext,
  root?: string,
  runtime?: string,
): Emitted {
  const cx = asEmitContext(inputOrContext);
  if (runtime) cx.runtime = runtime;
  const { source } = cx;

  const tests: EmittedTest[] = [];
  for (const { segs, body } of namespaces(source)) {
    if (root && segs[0] !== root) continue;
    for (const stmt of body.statements)
      if (isExportedTypeAlias(stmt) && isTest(cx, stmt.type))
        tests.push(...emitTestAlias(cx, stmt, segs));
  }
  // The header can only be written once every test has said what it needs.
  if (!tests.length) return { header: [], tests: [], warnings: cx.warnings };
  return { header: headerLines(cx), tests, warnings: cx.warnings };
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

declare namespace Tests.emitTests {
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
      "elsewhere > AlsoATest"
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
    'test("other > nested > Deep", async () => {'
  >;

  /** a file with no test namespace emits nothing at all */
  export type Nothing_ = Expect<
    Invoke<typeof printModule, ["const add = (a: number) => a;"]>,
    "=",
    ""
  >;
}

/** `export type X = …` inside a namespace block: one test. */
function isExportedTypeAlias(
  node: ts.Statement,
): node is ts.TypeAliasDeclaration {
  return (
    ts.isTypeAliasDeclaration(node) &&
    !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}
