// Test aliases and the namespace blocks they live in: peeling modifiers,
// printing one `test(…)` (or a `describe` of table rows), and walking the file
// for `declare namespace Tests…` blocks.
import ts from "typescript";

import { assertion, returnTypeOf, testBody } from "./assertion.mts";
import { callee, expr, tupleArgs } from "./expression.mts";

import {
  asEmitContext,
  ensureEmitContext,
  isInputOrContext,
} from "./context.mts";

import type { EmitInputOrContext, Line, TestState } from "./context.mts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";
import type {
  moduleWarnings,
  printTest,
  testNames,
} from "../../_internal/harness.mts";
/** One generated test: a top-level `test(…)`, every line anchored to the source. */
export type EmittedTest = {
  /** What Vitest reports: the namespace path and the alias, e.g. `add > Simple`. */
  name: string;
  /** Namespace segments below the root (`declare namespace Tests.parser.errors` → ["parser", "errors"]). */
  path: string[];
  /** The `export type` alias this test came from. */
  alias: string;
  /** For a `Table<…>` row, its 0-based index; null for an ordinary test. */
  row: number | null;
  /** 0-based line of the alias (or of the row) in the source file. */
  line: number;
  /** The generated lines, each anchored to the line it came from. */
  lines: Line[];
  /** `lines` joined: the test's source. */
  code: string;
};

/** What every test carries before its body is known. */
type TestMeta = Omit<EmittedTest, "lines" | "code">;

/** The name Vitest reports for a test: its namespace path, then the alias. */
export const testName = (path: string[], alias: string): string =>
  [...path, alias].join(" > ");

const makeTest = (meta: TestMeta, lines: Line[]): EmittedTest => ({
  ...meta,
  lines,
  code: lines.map((l) => l.code).join("\n"),
});

declare namespace Tests.testName {
  /** the namespace path a test was written in, then its alias */
  export type Cases = Table<
    typeof testName,
    [
      [
        args: [path: ["parser", "errors"], alias: "Deep"],
        expected: "parser > errors > Deep",
      ],
      [args: [path: [], alias: "AtTheRoot"], expected: "AtTheRoot"],
    ]
  >;
}

/**
 * Is this exported alias a test? It is if it was written as one of the DSL's
 * types — or a tuple of them, as the DSL's `Test` says. Which of those types
 * make a runnable test is not decided here: whatever an exported alias is, the
 * printer has a go at it, and says so where it cannot.
 */
export function isTest(
  inputOrContext: EmitInputOrContext,
  type: ts.TypeNode | null,
): boolean {
  ensureEmitContext(inputOrContext);
  if (!type) return false;
  if (ts.isTupleTypeNode(type))
    return (
      type.elements.length > 0 &&
      type.elements.every((element) =>
        isTest(
          inputOrContext,
          ts.isNamedTupleMember(element) ? element.type : element,
        ),
      )
    );
  return ts.isTypeReferenceNode(type) && !!inputOrContext.dslName(type);
}

declare namespace Tests.isTest {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace anything {
      export type Assertion = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;
      export type Skipped = Skip<Expect<1, "=", 1>>;
      export type Pending = Todo<"later">;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      export type Helper = { a: 1 };
      export type Value = Invoke<typeof add, [1, 1]>;
    }
  `;

  /** what the namespace is called does not decide; where the type came from does */
  export type Collected = Expect<
    Invoke<typeof testNames, [Suite]>,
    "=",
    [
      "anything > Assertion",
      "anything > Skipped",
      "anything > Pending",
      "anything > Rows[0]",
      "anything > Value"
    ]
  >;

  /** an exported alias that is not the DSL's at all is not a test */
  export type NotOurs = Expect<
    Invoke<typeof testNames, [Suite]>,
    "excludes",
    "anything > Helper"
  >;

  /**
   * `Value` is the DSL's, so it is collected — and the printer is the one that
   * says it cannot be run, reported where it is written.
   */
  export type SaysWhy = Expect<
    Invoke<typeof moduleWarnings, [Suite]>,
    "=",
    [
      "`Invoke<typeof add, [1, 1]>` is not a test: write Expect, Throws, Given or Table (or a tuple of them)"
    ]
  >;
}

/** Vitest options a `Configure<…>` sets on the generated test. */
export type TestOptions = { timeout?: number; retry?: number };

/** A test alias after its modifiers are peeled off. */
export type Peeled = {
  /** The Vitest function to call: `test`, `test.skip`, `test.only`, `test.todo`. */
  fn: string;
  options: TestOptions;
  /** The Test node left underneath, or null for `test.todo`. */
  node: ts.TypeNode | null;
};

/** Strip `Skip` / `Only` / `Todo` / `Configure` wrappers, collecting what they mean. */
export function peelModifiers(
  inputOrContext: EmitInputOrContext,
  type: ts.TypeNode | null,
): Peeled {
  ensureEmitContext(inputOrContext);
  let node = type;
  let fn = "test";
  const options: TestOptions = {};
  while (node && ts.isTypeReferenceNode(node)) {
    const dsl = inputOrContext.dslName(node);
    const m0: ts.TypeNode | undefined = node.typeArguments?.[0];
    const m1: ts.TypeNode | undefined = node.typeArguments?.[1];
    if (dsl === "Skip" && m0) {
      fn = "test.skip";
      node = m0;
    } else if (dsl === "Only" && m0) {
      fn = "test.only";
      node = m0;
    } else if (dsl === "Todo") {
      fn = "test.todo";
      node = null;
    } else if (dsl === "Configure" && m0 && m1) {
      if (ts.isTypeLiteralNode(m0)) {
        for (const m of m0.members) {
          if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || !m.type)
            continue;
          if (m.name.text === "timeout")
            options.timeout = Number(
              expr(inputOrContext, m.type).replace(/_/g, ""),
            );
          if (m.name.text === "retries")
            options.retry = Number(
              expr(inputOrContext, m.type).replace(/_/g, ""),
            );
        }
      }
      node = m1;
    } else break;
  }
  return { fn, options, node };
}

/** The JSDoc comment on a test alias, which becomes its description. */
export function docTextOf(decl: ts.TypeAliasDeclaration): string | undefined {
  const doc = ts.getJSDocCommentsAndTags(decl).find(ts.isJSDoc)?.comment;
  return doc === undefined
    ? undefined
    : typeof doc === "string"
      ? doc
      : doc.map((c) => c.text).join("");
}

/** Render an indented block of anchored statements. */
export const block = (stmts: Line[], indent: string): Line[] =>
  stmts.map((s) => ({ code: `${indent}${s.code}`, line: s.line }));

/** The `const` statements for the aliases the current test referenced. */
export const aliasStatements = (
  inputOrContextOrState: EmitInputOrContext | TestState,
): Line[] => {
  const state = isInputOrContext(inputOrContextOrState, "program")
    ? asEmitContext(inputOrContextOrState).state
    : inputOrContextOrState;
  return state.order.map((a) => ({ code: a.code, line: a.line }));
};

/** A test that fails on purpose: the authoring problem is reported as its body. */
function unsupportedTest(
  inputOrContext: EmitInputOrContext,
  meta: TestMeta,
  doc: Line[],
  node: ts.Node,
  why: string,
): EmittedTest {
  ensureEmitContext(inputOrContext);
  const call = inputOrContext.unsupported(node, why);
  return makeTest(meta, [
    ...doc,
    {
      code: `test(${inputOrContext.quote(meta.name)}, async () => {`,
      line: meta.line,
    },
    inputOrContext.statement(`  ${call};`, node),
    { code: `});`, line: meta.line },
  ]);
}

/** A `Table<fn, rows>`: one top-level test per row. */
export function tableTests(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeReferenceNode,
  meta: TestMeta,
  optText: string,
  doc: Line[],
): EmittedTest[] {
  ensureEmitContext(inputOrContext);
  const [fnNode, rowsNode] = node.typeArguments ?? [];
  if (!fnNode || !rowsNode || !ts.isTupleTypeNode(rowsNode))
    return [
      unsupportedTest(
        inputOrContext,
        meta,
        doc,
        node,
        "expects a function and a tuple of rows",
      ),
    ];
  return rowsNode.elements.map((r, i) => {
    inputOrContext.resetTest();
    const row = ts.isNamedTupleMember(r) ? r.type : r;
    const rowMeta: TestMeta = {
      ...meta,
      name: testName(meta.path, `${meta.alias}[${i}]`),
      row: i,
      line: inputOrContext.lineOf(row),
    };
    if (!ts.isTupleTypeNode(row))
      return unsupportedTest(
        inputOrContext,
        rowMeta,
        doc,
        row,
        "is not a table row",
      );
    const els = row.elements.map((e) =>
      ts.isNamedTupleMember(e) ? e.type : e,
    );
    const [argsN, condN, expN] =
      els.length === 2 ? [els[0], null, els[1]] : els;
    if (!argsN)
      return unsupportedTest(
        inputOrContext,
        rowMeta,
        doc,
        row,
        "is not a table row",
      );
    const call = `await ${callee(inputOrContext, fnNode)}(${tupleArgs(inputOrContext, argsN)})`;
    const stmts = assertion(
      inputOrContext,
      { code: call, type: returnTypeOf(inputOrContext, fnNode) },
      condN ?? null,
      expN ?? null,
      false,
      null,
      row,
    );
    // whether the row takes `{ task }` is known only once its body is printed
    const param = inputOrContext.state.usesTask ? "{ task }" : "";
    return makeTest(rowMeta, [
      ...doc,
      {
        code: `test(${inputOrContext.quote(rowMeta.name)}${optText}, async (${param}) => {`,
        line: rowMeta.line,
      },
      ...block([...aliasStatements(inputOrContext), ...stmts], "  "),
      { code: `});`, line: rowMeta.line },
    ]);
  });
}

/**
 * Print one exported test alias as top-level `test(…)` lines. A `Table<…>`
 * yields one entry per row; everything else yields exactly one.
 * @param path Namespace segments below the root.
 */
export function emitTestAlias(
  inputOrContext: EmitInputOrContext,
  decl: ts.TypeAliasDeclaration,
  path: string[] = [],
): EmittedTest[] {
  ensureEmitContext(inputOrContext);
  inputOrContext.resetTest();
  const alias = decl.name.text;
  const line = inputOrContext.lineOf(decl);
  const docText = docTextOf(decl);
  const doc: Line[] = docText
    ? [{ code: `/** ${docText.replace(/\n/g, " ")} */`, line }]
    : [];
  const { fn, options, node } = peelModifiers(inputOrContext, decl.type);
  const optText = Object.keys(options).length
    ? `, ${JSON.stringify(options)}`
    : "";
  const meta: TestMeta = {
    name: testName(path, alias),
    path,
    alias,
    row: null,
    line,
  };

  if (!node)
    return [
      makeTest(meta, [
        ...doc,
        { code: `${fn}(${inputOrContext.quote(meta.name)});`, line },
      ]),
    ];

  if (ts.isTypeReferenceNode(node) && inputOrContext.dslName(node) === "Table")
    return tableTests(inputOrContext, node, meta, optText, doc);

  const stmts = testBody(inputOrContext, node, false);
  const body = block([...aliasStatements(inputOrContext), ...stmts], "  ");
  const param = inputOrContext.state.usesTask ? "{ task }" : "";
  return [
    makeTest(meta, [
      ...doc,
      {
        code: `${fn}(${inputOrContext.quote(meta.name)}${optText}, async (${param}) => {`,
        line,
      },
      ...body,
      { code: `});`, line },
    ]),
  ];
}

declare namespace Tests.emitTestAlias {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace add {
      /** four plus five */
      export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      export type Later = Todo<"soon">;
      export type Skipped = Skip<Expect<1, "=", 1>>;
    }
  `;

  /** a test alias becomes one top-level test, its JSDoc kept as the description */
  export type Simple = Expect<
    Invoke<typeof printTest, [Suite, "Simple"]>,
    "=",
    '/** four plus five */\ntest("add > Simple", async () => {\n  expect(await add(4, 5)).toEqual(9);\n});'
  >;

  /** a table row is a test of its own, indexed by row */
  export type TableRow = Expect<
    Invoke<typeof printTest, [Suite, "Rows"]>,
    "=",
    'test("add > Rows[0]", async () => {\n  expect(await add(1, 1)).toEqual(2);\n});'
  >;

  /** `Todo` has no body at all */
  export type Pending = Expect<
    Invoke<typeof printTest, [Suite, "Later"]>,
    "=",
    'test.todo("add > Later");'
  >;

  /** `Skip` picks the Vitest function, and keeps the test underneath */
  export type Skipped = Expect<
    Invoke<typeof printTest, [Suite, "Skipped"]>,
    "includes",
    'test.skip("add > Skipped"'
  >;
}

/** Yield every namespace block with its flattened dotted name (`declare namespace A.B {}` → ["A", "B"]). */
export function* namespaces(
  node: ts.Node,
  prefix: string[] = [],
): Generator<{ segs: string[]; body: ts.ModuleBlock }> {
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    const segs = [...prefix, node.name.text];
    let body = node.body;
    while (body && ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
      segs.push(body.name.text);
      body = body.body;
    }
    if (body && ts.isModuleBlock(body)) yield { segs, body };
  } else for (const c of node.getChildren()) yield* namespaces(c, prefix);
}
