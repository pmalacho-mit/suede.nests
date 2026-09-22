// What the inline `declare namespace Tests…` tests cannot reach.
//
// Each stage of the printer is documented and pinned down by the tests written
// beside it, in the library's own DSL. What is left here is everything those
// cannot express: the shape of the context itself, anchoring, and the plumbing
// a test would need a `ts.Node` or a hand-made context slice to reach.
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  aliasStatements,
  assertion,
  chain,
  condition,
  displayConfig,
  docTextOf,
  emitTests,
  emitTestAlias,
  entityName,
  expectationFor,
  expr,
  headerLines,
  literalText,
  matcherTable,
  namespaces,
  peelModifiers,
  render,
  testBody,
  throwsMatcher,
  THROWS,
} from "../release/vite-plugin/emit/index.mts";
import { asEmitContext } from "../release/vite-plugin/emit/index.mts";
import { contextFor } from "./helpers.mts";

/** The printed code of each statement, ignoring anchors. */
const codes = (lines: { code: string }[]) => lines.map((l) => l.code);

describe("expression", () => {
  test("prints typeof and indexed access as property access", () => {
    const { cx, type } = contextFor(`
      const o = { a: { b: 1 } };
      const xs = [1, 2, 3];
      type Prop = (typeof o)["a"];
      type Item = (typeof xs)[0];
    `);
    // the parens of `(typeof o)` survive into the expression — harmless in JS
    expect(expr(cx, type("Prop"))).toBe("(o).a");
    // `!` because value-level indexing is optional under noUncheckedIndexedAccess
    expect(expr(cx, type("Item"))).toBe("(xs)[0]!");
  });

  test("hoists a referenced alias into a const, dependencies first", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      type Inner = Invoke<typeof add, [1, 2]>;
      type Outer = Invoke<typeof add, [Inner, 4]>;
      type Use = Outer;
    `);
    expect(expr(cx, type("Use"))).toBe("Outer");
    expect(cx.state.order.map((a) => a.code)).toEqual([
      "const Inner = await add(1, 2);",
      "const Outer = await add(Inner, 4);",
    ]);
    // aliasStatements also takes the bare state, not just a whole context
    expect(codes(aliasStatements(cx.state))).toEqual(
      cx.state.order.map((a) => a.code),
    );
  });

  test("suffixes an alias whose name is taken by a value in scope", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      const Sum = 0;
      declare namespace Tests.add {
        type Sum = Invoke<typeof add, [1, 2]>;
        type Ref = Sum;
      }
    `);
    expect(expr(cx, type("Ref"))).toBe("Sum$");
    expect(cx.state.order[0]?.code).toBe("const Sum$ = await add(1, 2);");
  });

  test("takes a bare { program, source }, not only a built context", () => {
    const { program, source, type } = contextFor(`
      const value = 1;
      type Ref = typeof value;
      type NotAValue = number;
    `);
    const input = { program, source };
    expect(expr(input, type("Ref"))).toBe("value");

    // the input is upgraded in place, so state accrues on the object passed in
    expr(input, type("NotAValue"));
    const cx = asEmitContext(input);
    expect(cx.warnings.map((w) => w.message)).toEqual([
      "`number` is a type, not a value",
    ]);
    expect(cx.source.fileName).toContain("__snippet__.ts");
  });

  test("literalText takes just the checker it uses", () => {
    const { cx, type } = contextFor(`type Str = "hello";`);
    expect(literalText(cx.checker, type("Str"))).toBe("hello");
    // and the whole context, or a bare input, all the same
    expect(literalText(cx, type("Str"))).toBe("hello");
  });

  test("entityName resolves the root identifier of a qualified name", () => {
    const { cx, type } = contextFor(`
      const value = { nested: 1 };
      type Ref = typeof value.nested;
    `);
    const query = type("Ref");
    if (!ts.isTypeQueryNode(query)) throw new Error("expected a type query");
    expect(entityName(cx, query.exprName)).toBe("value.nested");
  });
});

describe("matcher table", () => {
  /** The table is pure: no program, no AST — just printed strings. */
  const parts = (
    over: Partial<Parameters<typeof matcherTable>[0]> = {},
  ): Parameters<typeof matcherTable>[0] => ({
    actual: "actual",
    expected: "expected",
    param: undefined,
    expectFn: "expect",
    numeric: false,
    stringLike: false,
    isSnapshot: false,
    snapshotName: "",
    throwsChain: chain("toThrow", []),
    hasDisplay: false,
    line: (c) => `expect(actual)${c};`,
    ...over,
  });

  test("compiles a condition to a checked chain, not a string", () => {
    expect(expectationFor(parts(), "=")).toEqual({
      chain: { matcher: "toEqual", args: ["expected"] },
    });
    expect(expectationFor(parts(), "!=")).toEqual({
      chain: { matcher: "toEqual", args: ["expected"], negated: true },
    });
    expect(expectationFor(parts(), "truthy")).toEqual({
      chain: { matcher: "toBeTruthy", args: [] },
    });
  });

  test("covers every condition the DSL defines", () => {
    // `matcherTable` is typed `Record<ConditionName, …>`, so this list is
    // exhaustive by construction — a new DSL condition stops compilation.
    expect(Object.keys(matcherTable(parts())).sort()).toEqual(
      [
        "=", "!=", "<", "<=", ">", ">=", "~=", "defined", "endsWith", "every",
        "excludes", "falsy", "hasKey", "includes", "instanceOf", "is",
        "isEmpty", "isFinite", "isInteger", "isNaN", "isNot", "isNotEmpty",
        "lacksKey", "matches", "satisfies", "some", "startsWith", "throws",
        "truthy", "undefined",
      ].sort(),
    );
  });

});

describe("conditions and display pages", () => {
  test("reads the operator, and the parameter of a pair", () => {
    const { cx, type } = contextFor(`
      type Plain = "=";
      type Pair = ["~=", 0.5];
    `);
    expect(condition(cx, type("Plain"))).toEqual({ op: "=" });
    expect(condition(cx, type("Pair"))).toEqual({ op: "~=", param: "0.5" });
    expect(condition(cx, THROWS)).toEqual({ op: "throws" });
  });

  test("accepts a display page as a string or an object", () => {
    const { cx, type } = contextFor(`
      type Short = "./page.html";
      type Full = { display: "./page.html"; displayMeta: { bins: 4 } };
      type Neither = { nope: 1 };
    `);
    expect(displayConfig(cx, type("Short"))).toEqual({
      display: "./page.html",
      meta: null,
    });
    expect(displayConfig(cx, type("Full"))).toEqual({
      display: "./page.html",
      meta: "{ bins: 4 }",
    });
    expect(displayConfig(cx, type("Neither"))).toBeNull();
    expect(displayConfig(cx, null)).toBeNull();
  });

  test("builds the throws matcher from a class, a message or a matcher literal", () => {
    const { cx, type } = contextFor(`
      type Matcher = { instanceOf: RangeError; message: "boom" };
      type Pattern = { matches: "/bo+m/" };
    `);
    expect(throwsMatcher(cx, null, "undefined")).toEqual({
      matcher: "toThrow",
      args: [],
    });
    expect(throwsMatcher(cx, type("Matcher"), "RangeError")).toEqual({
      matcher: "toSatisfy",
      args: [
        '(err) => err instanceof RangeError && String(err.message).includes("boom")',
      ],
    });
    expect(throwsMatcher(cx, type("Pattern"), "x")).toEqual({
      matcher: "toSatisfy",
      args: ["(err) => /bo+m/.test(String(err.message))"],
    });
  });
});

describe("assertions", () => {
  test("compares a typed array against a tuple as a plain array", () => {
    const { cx, type } = contextFor(`
      const bytes = () => new Uint8Array([1, 2]);
      type Actual = Invoke<typeof bytes, []>;
      type Cond = "=";
      type Expected = [1, 2];
    `);
    expect(
      codes(
        assertion(cx, type("Actual"), type("Cond"), type("Expected"), false),
      ),
    ).toEqual(["expect(Array.from(await bytes())).toEqual([1, 2]);"]);
  });

  test("routes through ntCheck when a display page is configured", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      type Actual = Invoke<typeof add, [4, 5]>;
      type Cond = "=";
      type Expected = 9;
      type Config = "./page.html";
    `);
    const [line] = codes(
      assertion(
        cx,
        type("Actual"),
        type("Cond"),
        type("Expected"),
        false,
        type("Config"),
      ),
    );
    expect(line).toBe(
      `await ntCheck(task, { display: "./page.html", meta: undefined, soft: false }, async () => await add(4, 5), 9, (actual) => expect(actual).toEqual(9));`,
    );
    expect(cx.state.usesTask).toBe(true);
  });

  test("hoists an awaited expected out of a callback", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      const pred = (n: number) => n > 0;
      type Actual = Invoke<typeof add, [1, 2]>;
      type Cond = "satisfies";
      type Expected = Invoke<typeof pred, [1]>;
    `);
    expect(
      codes(
        assertion(cx, type("Actual"), type("Cond"), type("Expected"), false),
      ),
    ).toEqual([
      "const expected = await pred(1);",
      "expect(await add(1, 2)).toSatisfy(expected);",
    ]);
  });

  test("warns when a node is not a test at all", () => {
    const { cx, type } = contextFor(`type NotATest = 1;`);
    expect(codes(testBody(cx, type("NotATest"), false))).toEqual([
      `nt_unsupported("1");`,
    ]);
    expect(cx.warnings[0]?.message).toBe(
      "`1` is not a test: write Expect, Throws, Given or Table (or a tuple of them)",
    );
  });
});

describe("tests and suites", () => {
  test("peels the modifiers off a test alias", () => {
    const { cx, alias } = contextFor(`
      type Plain = Expect<1, "=", 1>;
      type Skipped = Skip<Expect<1, "=", 1>>;
      type Focused = Only<Expect<1, "=", 1>>;
      type Pending = Todo<"later">;
      type Slow = Configure<{ timeout: 50; retries: 2 }, Expect<1, "=", 1>>;
    `);
    expect(peelModifiers(cx, alias("Plain").type).fn).toBe("test");
    expect(peelModifiers(cx, alias("Skipped").type).fn).toBe("test.skip");
    expect(peelModifiers(cx, alias("Focused").type).fn).toBe("test.only");

    const pending = peelModifiers(cx, alias("Pending").type);
    expect(pending.fn).toBe("test.todo");
    expect(pending.node).toBeNull();

    const slow = peelModifiers(cx, alias("Slow").type);
    expect(slow.options).toEqual({ timeout: 50, retry: 2 });
    expect(slow.node).not.toBeNull();
  });

  test("takes the description from the alias's JSDoc", () => {
    const { alias } = contextFor(`
      /** adds two numbers */
      type Documented = Expect<1, "=", 1>;
      type Bare = Expect<1, "=", 1>;
    `);
    expect(docTextOf(alias("Documented"))).toBe("adds two numbers");
    expect(docTextOf(alias("Bare"))).toBeUndefined();
  });

  test("anchors each generated line to the source line it came from", () => {
    const { cx, source } = contextFor(`
      const add = (a: number, b: number) => a + b;
      declare namespace Tests.add {
        type Sum = Invoke<typeof add, [4, 5]>;
        export type Simple = Expect<Sum, "=", 9>;
      }
    `);
    const decl = [...namespaces(source)]
      .flatMap((n) => [...n.body.statements])
      .find((s) => s.getText().includes("Simple"));
    const [emitted] = emitTestAlias(cx, decl as never, ["add"]);
    const text = source.getFullText().split("\n");
    // the `test(` line and the alias const point back at what they came from
    const anchored = (emitted?.lines ?? []).map((l) =>
      l.line === null ? null : text[l.line]?.trim(),
    );
    expect(anchored).toEqual([
      "export type Simple = Expect<Sum, \"=\", 9>;",
      "type Sum = Invoke<typeof add, [4, 5]>;",
      "export type Simple = Expect<Sum, \"=\", 9>;",
      "export type Simple = Expect<Sum, \"=\", 9>;",
    ]);
  });

  test("flattens dotted namespace names into describe paths", () => {
    const { source } = contextFor(`
      declare namespace Tests.parser.errors {
        export type T = Expect<1, "=", 1>;
      }
      declare namespace Other {
        export type U = Expect<1, "=", 1>;
      }
    `);
    expect([...namespaces(source)].map((n) => n.segs)).toEqual([
      ["Tests", "parser", "errors"],
      ["Other"],
    ]);
  });
});

describe("generated header", () => {
  /** No program needed: the header only reads four fields off the context. */
  const header = (over: Partial<Parameters<typeof headerLines>[0]> = {}) =>
    headerLines({
      used: { fs: false, env: false, task: false },
      imports: new Map(),
      warnings: [],
      quote: (s: string) => JSON.stringify(s),
      runtime: "@namespace-tests/vite-plugin/runtime",
      ...over,
    });

  test("always imports Vitest, and nothing else by default", () => {
    expect(header()).toEqual([
      "// ───────── generated by namespace-tests; not part of your build ─────────",
      'import { test, expect } from "vitest";',
    ]);
  });

  test("adds the helpers the printed tests turned out to need", () => {
    const lines = header({
      used: { fs: true, env: true, task: true },
      warnings: [{ line: 0, column: 0, length: 1, message: "x" }],
    });
    expect(lines).toContain(
      'import { ntCheck } from "@namespace-tests/vite-plugin/runtime";',
    );
    expect(lines).toContain('import { readFileSync } from "node:fs";');
    expect(lines.some((l) => l.startsWith("const nt_unsupported ="))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith("const nt_env ="))).toBe(true);
  });

  test("re-imports type-only bindings as values", () => {
    const lines = header({
      imports: new Map([
        ["./mod", new Set(["a as a$", "default as d$", "* as ns$"])],
      ]),
    });
    expect(lines).toContain(
      'import * as ns$ from "./mod"; // value import: the original import is type-only',
    );
    expect(lines).toContain(
      'import { a as a$, default as d$ } from "./mod"; // value import: the original import is type-only',
    );
  });
});

describe("emitTests", () => {
  const file = () =>
    contextFor(`
      const add = (a: number, b: number) => a + b;
      declare namespace Tests.add {
        export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
        export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      }
      declare namespace Tests.other.nested {
        export type Deep = Expect<1, "=", 1>;
      }
      declare namespace NotTests {
        export type Ignored = Expect<1, "=", 2>;
      }
    `);

  test("every entry is a top-level test, never a describe", () => {
    const { program, source } = file();
    for (const t of emitTests({ program, source }).tests) {
      expect(t.code).toMatch(/^test(\.\w+)?\(/m);
      expect(t.code).not.toContain("describe(");
      expect(t.lines.every((l) => l.line !== null)).toBe(true);
    }
  });

  test("the header is shared, and rendered ahead of every test", () => {
    const { program, source } = file();
    const emitted = emitTests({ program, source });
    expect(emitted.header).toContain('import { test, expect } from "vitest";');
    const { code, anchors } = render(emitted);
    expect(anchors).toHaveLength(code.split("\n").length);
    expect(code.startsWith(emitted.header.join("\n"))).toBe(true);
    for (const t of emitted.tests) expect(code).toContain(t.code);
  });

});
