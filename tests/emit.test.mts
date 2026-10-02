// What the inline `declare namespace` tests cannot reach.
//
// Each stage of the printer is documented and pinned down by the tests written
// beside it, in the library's own DSL. What is left here is everything those
// cannot express: the shape of the IR itself, anchoring, and the plumbing a
// test would need a `ts.Node` or a bare `{ program, source }` to reach.
import { describe, expect, test } from "vitest";
import {
  emitTests,
  lowerAlias,
  lowerBody,
  lowerExpr,
  namespaces,
  needsOf,
  printExpr,
  printStatement,
  printTest,
  render,
} from "../release/vite-plugin/emit/index.mts";
import { contextFor } from "./helpers.mts";

describe("expressions", () => {
  test("typeof and indexed access lower to a value and a member read", () => {
    const { cx, type } = contextFor(`
      const o = { a: { b: 1 } };
      const xs = [1, 2, 3];
      type Prop = (typeof o)["a"];
      type Item = (typeof xs)[0];
    `);
    expect(lowerExpr(cx, type("Prop"))).toEqual({
      kind: "index",
      object: { kind: "paren", inner: { kind: "name", name: "o" } },
      key: "a",
    });
    // the parens of `(typeof o)` survive into the expression — harmless in JS;
    // `!` because value-level indexing is optional under noUncheckedIndexedAccess
    expect(printExpr(lowerExpr(cx, type("Item")))).toBe("(xs)[0]!");
  });

  test("hoists a referenced alias into a binding, dependencies first", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      type Inner = Invoke<typeof add, [1, 2]>;
      type Outer = Invoke<typeof add, [Inner, 4]>;
      type Use = Outer;
    `);
    expect(lowerExpr(cx, type("Use"))).toEqual({ kind: "name", name: "Outer" });
    expect(cx.test.order.map((b) => b.name)).toEqual(["Inner", "Outer"]);
    expect(cx.test.order[1]?.value).toEqual({
      kind: "call",
      awaited: false,
      callee: { kind: "name", name: "add" },
      args: [
        { kind: "name", name: "Inner" },
        { kind: "literal", source: "4" },
      ],
    });
  });

  test("a generic alias becomes a function, and its defaults become defaults", () => {
    const { cx, alias, type } = contextFor(`
      const key = (source: string, root?: string) => \`\${source}:\${root}\`;
      type Key<Source extends string, Root extends string | undefined = undefined> =
        Invoke<typeof key, [Source, Root]>;
      type Ref = Key<"a.ts">;
      declare namespace key {
        export type Same = Expect<Key<"a.ts">, "=", Key<"a.ts", undefined>>;
      }
    `);
    // the reference leaves `Root` out, so the call does too — the parameter has
    // to carry the default the type parameter declared, or `key` is called with
    // one argument less than it was written to take
    expect(printExpr(lowerExpr(cx, type("Ref")))).toBe('Key("a.ts")');
    expect(cx.test.order[0]?.params).toEqual([
      { name: "Source", type: "string", fallback: null },
      {
        name: "Root",
        type: "string | undefined",
        fallback: { kind: "literal", source: "undefined" },
      },
    ]);
    const [emitted] = lowerAlias(cx, alias("Same"), ["key"]).map(printTest);
    expect(emitted?.code).toContain(
      "const Key = (Source: string, Root: string | undefined = undefined) =>",
    );
  });

  test("an alias over an async function is async, and calling it awaits", () => {
    const { cx, alias } = contextFor(`
      const load = async (id: string) => ({ id });
      declare namespace load {
        type Loaded<Id extends string> = Invoke<typeof load, [Id]>;
        export type Roundtrip = Expect<Loaded<"a">["id"], "=", "a">;
      }
    `);
    const [emitted] = lowerAlias(cx, alias("Roundtrip"), ["load"]).map(printTest);
    // the arrow awaits, so calling it gives back a promise — and the member is
    // read from what that promise resolved to, not from the promise
    expect(emitted?.code).toBe(
      [
        'test("load > Roundtrip", async () => {',
        "  const Loaded = async (Id: string) => await load(Id);",
        '  const actual = (await Loaded("a")).id;',
        '  const expected = "a";',
        "  expect(actual).toEqual(expected);",
        "});",
      ].join("\n"),
    );
  });

  test("suffixes an alias whose name is taken by a value in scope", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      const Sum = 0;
      declare namespace add {
        type Sum = Invoke<typeof add, [1, 2]>;
        type Ref = Sum;
      }
    `);
    expect(printExpr(lowerExpr(cx, type("Ref")))).toBe("Sum$");
  });

  test("re-imports a type-only binding as a value, for this test only", () => {
    const { cx, type } = contextFor(`
      import type { existsSync } from "node:fs";
      type Ref = typeof existsSync;
    `);
    expect(printExpr(lowerExpr(cx, type("Ref")))).toBe("existsSync$");
    expect([...cx.test.imports]).toEqual([
      ["node:fs", new Set(["existsSync as existsSync$"])],
    ]);
  });
});

describe("assertions", () => {
  test("compares a typed array against a tuple as a plain array", () => {
    const { cx, type } = contextFor(`
      const bytes = () => new Uint8Array([1, 2]);
      type Subject = Expect<Invoke<typeof bytes>, "=", [1, 2]>;
    `);
    const [statement] = lowerBody(cx, type("Subject"), false);
    expect(statement).toMatchObject({ kind: "assert", shape: "typedArray" });
    expect(printStatement(statement!)).toEqual([
      "const actual = Array.from(bytes());",
      "const expected = [1, 2];",
      "expect(actual).toEqual(expected);",
    ]);
  });

  test("records the values for a display page, then asserts as any test does", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      type Subject = Expect<Invoke<typeof add, [4, 5]>, "=", 9, "./page.html">;
      type Full = Expect<1, "=", 1, { display: "./page.html"; displayMeta: { bins: 4 } }>;
    `);
    const [statement] = lowerBody(cx, type("Subject"), false);
    expect(statement).toMatchObject({
      display: { page: "./page.html", meta: null },
    });
    expect(printStatement(statement!)).toEqual([
      "const actual = add(4, 5);",
      "const expected = 9;",
      'await recordArtifact(task, { type: "namespace-tests:display", page: "./page.html", actual: encode(actual), expected: encode(expected) });',
      "expect(actual).toEqual(expected);",
    ]);
    const [full] = lowerBody(cx, type("Full"), false);
    expect(full).toMatchObject({
      display: { page: "./page.html", meta: { kind: "object" } },
    });
    expect(printStatement(full!)).toContain(
      'await recordArtifact(task, { type: "namespace-tests:display", page: "./page.html", actual: encode(actual), expected: encode(expected), meta: encode({ bins: 4 }) });',
    );
  });

  test("hoists an awaited expected out of a callback", () => {
    const { cx, type } = contextFor(`
      const add = (a: number, b: number) => a + b;
      const pred = (n: number) => n > 0;
      type Subject = Expect<Invoke<typeof add, [1, 2]>, "satisfies", Invoke<typeof pred, [1]>>;
    `);
    expect(
      lowerBody(cx, type("Subject"), false).flatMap((s) => printStatement(s)),
    ).toEqual([
      "const actual = add(1, 2);",
      "const expected = pred(1);",
      "expect(actual).toSatisfy(expected);",
    ]);
  });

  test("a string that merely mentions await is not hoisted", () => {
    const { cx, type } = contextFor(`
      const check = (s: string) => s.length > 0;
      type Subject = Expect<"an await in a string", "satisfies", typeof check>;
    `);
    expect(
      lowerBody(cx, type("Subject"), false).flatMap((s) => printStatement(s)),
    ).toEqual([
      'const actual = "an await in a string";',
      "expect(actual).toSatisfy(check);",
    ]);
  });

  test("builds the throws matcher from a class, a message or a matcher literal", () => {
    const { cx, type } = contextFor(`
      const boom = () => { throw new RangeError("boom"); };
      type Class = Throws<Invoke<typeof boom>, RangeError>;
      type Matcher = Throws<Invoke<typeof boom>, { instanceOf: RangeError; message: "boom" }>;
      type Pattern = Throws<Invoke<typeof boom>, { matches: "/bo+m/" }>;
    `);
    const printed = (alias: string) =>
      lowerBody(cx, type(alias), false).flatMap(printStatement)[0];
    expect(printed("Class")).toBe(
      "expect(() => (boom())).toThrow(RangeError);",
    );
    // a matcher literal is a predicate over the error, and `.rejects` is the
    // only thing that hands one the error — so even a synchronous subject is
    // asserted as a rejection
    expect(printed("Matcher")).toBe(
      'await expect(async () => (boom())).rejects.toSatisfy((err) => err instanceof RangeError && String(err.message).includes("boom"));',
    );
    expect(printed("Pattern")).toBe(
      "await expect(async () => (boom())).rejects.toSatisfy((err) => /bo+m/.test(String(err.message)));",
    );
  });

  test("warns about a condition the DSL does not have, where it was written", () => {
    // `"nope"` is not a condition; the DSL rejects it, and so must the printer
    const { cx, type } = contextFor(`type Subject = Expect<1, "nope", 1>;`);
    expect(
      lowerBody(cx, type("Subject"), false).flatMap(printStatement),
    ).toEqual(['nt_unsupported("\\"nope\\"");']);
    expect(cx.warnings[0]?.message).toBe('`"nope"` is not a known condition');
  });
});

describe("test cases", () => {
  test("reads the modifiers off a test alias", () => {
    const { cx, alias } = contextFor(`
      type Plain = Expect<1, "=", 1>;
      type Skipped = Skip<Expect<1, "=", 1>>;
      type Focused = Only<Expect<1, "=", 1>>;
      type Pending = Todo<"later">;
      type Slow = Configure<{ timeout: 50; retries: 2 }, Expect<1, "=", 1>>;
    `);
    const modeOf = (name: string) => lowerAlias(cx, alias(name))[0]?.mode;
    expect(modeOf("Plain")).toBe("test");
    expect(modeOf("Skipped")).toBe("test.skip");
    expect(modeOf("Focused")).toBe("test.only");
    expect(lowerAlias(cx, alias("Pending"))[0]).toMatchObject({
      mode: "test.todo",
      body: [],
    });
    expect(lowerAlias(cx, alias("Slow"))[0]).toMatchObject({
      options: { timeout: 50, retry: 2 },
      body: [{ kind: "assert" }],
    });
  });

  test("takes the description from the alias's JSDoc", () => {
    const { cx, alias } = contextFor(`
      /** adds two numbers */
      type Documented = Expect<1, "=", 1>;
      type Bare = Expect<1, "=", 1>;
    `);
    expect(lowerAlias(cx, alias("Documented"))[0]?.doc).toEqual({
      text: "adds two numbers",
      line: 3,
    });
    expect(lowerAlias(cx, alias("Bare"))[0]?.doc).toBeNull();
  });

  test("anchors each generated line to the source line it came from", () => {
    const { cx, source, alias } = contextFor(`
      const add = (a: number, b: number) => a + b;
      declare namespace add {
        type Sum = Invoke<typeof add, [4, 5]>;
        export type Simple = Expect<Sum, "=", 9>;
      }
    `);
    const [emitted] = lowerAlias(cx, alias("Simple"), ["add"]).map(printTest);
    const text = source.getFullText().split("\n");
    // the `test(` line and the alias const point back at what they came from
    expect(
      emitted?.lines.map((l) =>
        l.line === null ? null : text[l.line]?.trim(),
      ),
    ).toEqual([
      'export type Simple = Expect<Sum, "=", 9>;',
      "type Sum = Invoke<typeof add, [4, 5]>;",
      // the locals an assertion binds are anchored to the assertion itself
      'export type Simple = Expect<Sum, "=", 9>;',
      'export type Simple = Expect<Sum, "=", 9>;',
      'export type Simple = Expect<Sum, "=", 9>;',
    ]);
  });

  test("says what each test needs from the preamble, and no more", () => {
    const { cx, alias } = contextFor(`
      declare namespace a {
        export type Reads = Expect<FromFile<"./a.txt">, "=", "hi">;
        export type Env_ = Expect<Env<"TOKEN">, "=", "x">;
        export type Shown = Expect<1, "=", 1, "./page.html">;
        export type Plain = Expect<1, "=", 1>;
      }
    `);
    const needs = (name: string) => needsOf(lowerAlias(cx, alias(name))[0]!);
    expect(needs("Reads")).toMatchObject({ fs: true, env: false, task: false });
    expect(needs("Env_")).toMatchObject({ fs: false, env: true, task: false });
    expect(needs("Shown")).toMatchObject({ task: true, unsupported: false });
    expect(needs("Plain")).toMatchObject({
      fs: false,
      env: false,
      task: false,
      unsupported: false,
    });
  });

  test("flattens dotted namespace names into paths", () => {
    const { source } = contextFor(`
      declare namespace parser.errors {
        export type T = Expect<1, "=", 1>;
      }
      declare namespace Other {
        export type U = Expect<1, "=", 1>;
      }
    `);
    expect([...namespaces(source)].map((n) => n.segs)).toEqual([
      ["parser", "errors"],
      ["Other"],
    ]);
  });
});

describe("emitTests", () => {
  const file = () =>
    contextFor(`
      const add = (a: number, b: number) => a + b;
      declare namespace add {
        export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
        export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      }
      declare namespace other.nested {
        export type Deep = Expect<1, "=", 1>;
      }
    `);

  test("every entry is a top-level test, never a describe, anchored throughout", () => {
    for (const t of emitTests(file()).tests) {
      expect(t.code).toMatch(/^test(\.\w+)?\(/m);
      expect(t.code).not.toContain("describe(");
      expect(t.lines.every((l) => l.line !== null)).toBe(true);
    }
  });

  test("the header is shared, and rendered ahead of every test", () => {
    const emitted = emitTests(file());
    expect(emitted.header).toContain('import { test, expect } from "vitest";');
    const { code, anchors } = render(emitted);
    expect(anchors).toHaveLength(code.split("\n").length);
    expect(code.startsWith(emitted.header.join("\n"))).toBe(true);
    for (const t of emitted.tests) expect(code).toContain(t.code);
  });
});
