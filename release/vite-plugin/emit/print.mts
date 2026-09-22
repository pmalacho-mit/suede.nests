// IR → Vitest source. Nothing here reads a `ts.Node`: an expression prints as
// the JavaScript it stands for, each DSL condition maps onto a built-in
// `expect` matcher, and a test case becomes one top-level `test(…)` with every
// line anchored to the source line it came from.
import { awaits, children, exprsOf } from "./ir.mts";

import type { Assertion as VitestAssertion } from "vitest";
import type { Line } from "./context.mts";
import type {
  Assertion,
  Binding,
  ConditionName,
  Expr,
  Param,
  Statement,
  TestCase,
} from "./ir.mts";

import type { Table } from "../../dsl.import.meta.vitest.ts";
import type { printStatements } from "../../_internal/harness.mts";

const quote = (s: string) => JSON.stringify(s);

const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

/** An object key as JavaScript writes it: bare when it can be, quoted otherwise. */
const propKey = (name: string) => (isIdentifier(name) ? name : quote(name));

// ── expressions ─────────────────────────────────────────────────────────────

/** Would this print with an `await` or `new` in front, so a member access needs parentheses? */
const needsParens = (e: Expr) =>
  e.kind === "construct" ||
  ((e.kind === "call" || e.kind === "method") && e.awaited);

const receiver = (e: Expr) =>
  needsParens(e) ? `(${printExpr(e)})` : printExpr(e);

const list = (args: Expr[]) => args.map(printExpr).join(", ");

export function printExpr(e: Expr): string {
  switch (e.kind) {
    case "string":
      return quote(e.value);
    case "literal":
      return e.source;
    case "array":
      return `[${list(e.elements)}]`;
    case "object":
      return e.entries.length
        ? `{ ${e.entries.map(([k, v]) => `${propKey(k)}: ${printExpr(v)}`).join(", ")} }`
        : "{}";
    case "name":
      return e.name;
    case "call":
      return `${e.awaited ? "await " : ""}${receiver(e.callee)}(${list(e.args)})`;
    case "construct":
      return `new ${receiver(e.callee)}(${list(e.args)})`;
    case "method":
      return `${e.awaited ? "await " : ""}${receiver(e.receiver)}${member(e.method)}(${list(e.args)})`;
    case "index":
      // `!`: type-level X[0] is never undefined; value-level x[0] may be under noUncheckedIndexedAccess
      return typeof e.key === "number"
        ? `${receiver(e.object)}[${e.key}]!`
        : `${receiver(e.object)}${member(e.key)}`;
    case "file": {
      const url = `new URL(${printExpr(e.path)}, import.meta.url)`;
      return e.format === "bytes"
        ? `new Uint8Array(readFileSync(${url}))`
        : e.format === "json"
          ? `JSON.parse(readFileSync(${url}, "utf8"))`
          : `readFileSync(${url}, "utf8")`;
    }
    case "env":
      return e.fallback
        ? `(process.env[${quote(e.name)}] ?? ${printExpr(e.fallback)})`
        : `nt_env(${quote(e.name)})`;
    case "snapshot":
      return "undefined"; // only `"="` gives a snapshot a meaning; see `matchers`
    case "paren":
      return `(${printExpr(e.inner)})`;
    case "unsupported":
      return `nt_unsupported(${quote(e.source)})`;
  }
}

/** `.name`, or `["not an identifier"]`. */
const member = (key: string) =>
  isIdentifier(key) ? `.${key}` : `[${quote(key)}]`;

declare namespace printExpr {
  type Call = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: true;
  };

  type SyncCall = {
    kind: "call";
    callee: { kind: "name"; name: "f" };
    args: [];
    awaited: false;
  };

  /** a member of an awaited call is read from the awaited value, not the promise */
  export type Members = Table<
    typeof printExpr,
    [
      [
        args: [{ kind: "index"; object: Call; key: "x" }],
        expected: "(await f()).x",
      ],
      [
        args: [{ kind: "index"; object: Call; key: 0 }],
        expected: "(await f())[0]!",
      ],
      [
        args: [{ kind: "index"; object: Call; key: "not-a-name" }],
        expected: '(await f())["not-a-name"]',
      ],
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: true;
          },
        ],
        expected: "await (await f()).m()",
      ],
    ]
  >;

  /** a call that returns no promise reads as the call it is: no await, no parentheses */
  export type Synchronous = Table<
    typeof printExpr,
    [
      [args: [SyncCall], expected: "f()"],
      [
        args: [{ kind: "index"; object: SyncCall; key: "x" }],
        expected: "f().x",
      ],
      [
        args: [
          {
            kind: "method";
            receiver: SyncCall;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "f().m()",
      ],
      /** one awaited step is enough to parenthesise what follows it */
      [
        args: [
          {
            kind: "method";
            receiver: Call;
            method: "m";
            args: [];
            awaited: false;
          },
        ],
        expected: "(await f()).m()",
      ],
    ]
  >;

  /** a string is quoted as JSON would: the printer never sees escapes */
  export type Strings = Table<
    typeof printExpr,
    [
      [args: [{ kind: "string"; value: "a\\d" }], expected: '"a\\\\d"'],
      [
        args: [
          {
            kind: "object";
            entries: [["b-c", { kind: "literal"; source: "1" }]];
          },
        ],
        expected: '{ "b-c": 1 }',
      ],
      [args: [{ kind: "object"; entries: [] }], expected: "{}"],
    ]
  >;
}

// ── conditions ──────────────────────────────────────────────────────────────

/** A matcher on Vitest's `expect(…)`: anything callable, so `not`/`resolves` aside. */
type Callable = (...args: never[]) => unknown;

/** The name of a real Vitest matcher — a typo cannot get past this. */
type MatcherName = {
  [K in keyof VitestAssertion & string]-?: VitestAssertion[K] extends Callable
    ? K
    : never;
}[keyof VitestAssertion & string];

/** Homomorphic, so a tuple of parameters stays a tuple. */
type Printed<P extends readonly unknown[]> = { [I in keyof P]: string };

/** One printed argument per parameter the matcher declares. */
type PrintedArgs<K extends MatcherName> = Printed<
  Parameters<Extract<VitestAssertion[K], Callable>>
>;

/** An `expect` chain: what goes after `expect(subject)`. */
export type Chain = {
  matcher: string;
  args: string[];
  /** `.not` before the matcher. */
  negated?: boolean;
  /** `.rejects` before the matcher: the subject is a thunk that must reject. */
  rejects?: boolean;
  /** Assert on this instead of the actual itself (`"~="`, ordering on non-numbers). */
  subject?: string;
};

/**
 * Build one `expect` chain. `matcher` must name a Vitest matcher and `args`
 * must print one argument per parameter it takes, so the printer cannot emit
 * `.toEqul(…)` or forget an expected value.
 */
const chain = <K extends MatcherName>(
  matcher: K,
  args: PrintedArgs<K>,
  rest: Omit<Chain, "matcher" | "args"> = {},
): Chain => ({ matcher, args: args as string[], ...rest });

/** The operands of an assertion, already printed. */
type Operands = { actual: string; expected: string; param: string };

/** An ordering condition: a matcher on numbers, a plain comparison otherwise. */
const ordering =
  (
    matcher:
      | "toBeGreaterThan"
      | "toBeGreaterThanOrEqual"
      | "toBeLessThan"
      | "toBeLessThanOrEqual",
    operator: string,
  ) =>
  (a: Assertion, { actual, expected }: Operands): Chain =>
    a.shape === "number"
      ? chain(matcher, [expected])
      : chain("toBe", ["true"], {
          subject: `${actual} ${operator} ${expected}`,
        });

/** A predicate over a collection, spelled out because `toSatisfy<E>` does not infer `E`. */
const collection = (method: "some" | "every") => (_: Assertion, p: Operands) =>
  chain("toSatisfy", [
    `(xs: ArrayLike<any>) => Array.from(xs).${method}(${p.expected})`,
  ]);

/** Condition → the chain it compiles to. Exhaustive over the DSL. */
const matchers: Record<ConditionName, (a: Assertion, p: Operands) => Chain> = {
  "=": (a, p) =>
    a.expected?.kind === "snapshot"
      ? chain(
          "toMatchSnapshot",
          a.expected.name ? [printExpr(a.expected.name)] : [],
        )
      : chain("toEqual", [p.expected]),
  "!=": (_, p) => chain("toEqual", [p.expected], { negated: true }),
  is: (_, p) => chain("toBe", [p.expected]),
  isNot: (_, p) => chain("toBe", [p.expected], { negated: true }),
  satisfies: (_, p) => chain("toSatisfy", [p.expected]),
  instanceOf: (_, p) => chain("toBeInstanceOf", [p.expected]),
  truthy: () => chain("toBeTruthy", []),
  falsy: () => chain("toBeFalsy", []),
  defined: () => chain("toBeDefined", []),
  undefined: () => chain("toBeUndefined", []),
  throws: (a) => ({ ...throwsChain(a.expected), rejects: rejectsFor(a) }),
  ">": ordering("toBeGreaterThan", ">"),
  ">=": ordering("toBeGreaterThanOrEqual", ">="),
  "<": ordering("toBeLessThan", "<"),
  "<=": ordering("toBeLessThanOrEqual", "<="),
  "~=": (_, p) =>
    chain("toBeLessThanOrEqual", [p.param], {
      subject: `Math.abs(${p.actual} - ${p.expected})`,
    }),
  includes: (_, p) => chain("toContain", [p.expected]),
  excludes: (_, p) => chain("toContain", [p.expected], { negated: true }),
  startsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.startsWith(${p.expected})`]),
  endsWith: (_, p) =>
    chain("toSatisfy", [`(s: string) => s.endsWith(${p.expected})`]),
  matches: (a, p) =>
    a.shape === "string" && a.expected
      ? chain("toMatch", [regex(a.expected)])
      : chain("toMatchObject", [p.expected]),
  some: collection("some"),
  every: collection("every"),
  isEmpty: () => chain("toHaveLength", ["0"]),
  isNotEmpty: () => chain("toHaveLength", ["0"], { negated: true }),
  hasKey: (_, p) => chain("toHaveProperty", [p.expected]),
  lacksKey: (_, p) => chain("toHaveProperty", [p.expected], { negated: true }),
  isNaN: () => chain("toBeNaN", []),
  isInteger: () => chain("toSatisfy", ["Number.isInteger"]),
  isFinite: () => chain("toSatisfy", ["Number.isFinite"]),
};

/** Does the DSL have a condition of this name? */
export const isCondition = (op: string): op is ConditionName =>
  Object.hasOwn(matchers, op);

/** `.rejects`, `.not`, the matcher and its arguments, as source text. */
const printChain = (c: Chain): string =>
  `${c.rejects ? ".rejects" : ""}${c.negated ? ".not" : ""}.${c.matcher}(${c.args.join(", ")})`;

declare namespace matchers {
  /** every condition, as the statement it prints */
  export type Conditions = Table<
    typeof printStatements,
    [
      [
        args: ['type Subject = Expect<"a", "=", "b">;'],
        expected: ['expect("a").toEqual("b");'],
      ],
      [
        args: ['type Subject = Expect<"a", "!=", "b">;'],
        expected: ['expect("a").not.toEqual("b");'],
      ],
      [
        args: ['type Subject = Expect<1, "is", 1>;'],
        expected: ["expect(1).toBe(1);"],
      ],
      [
        args: ['type Subject = Expect<"ab", "includes", "b">;'],
        expected: ['expect("ab").toContain("b");'],
      ],
      [
        args: ['type Subject = Expect<[], "isEmpty">;'],
        expected: ["expect([]).toHaveLength(0);"],
      ],
      [
        args: ['type Subject = Expect<1, "isInteger">;'],
        expected: ["expect(1).toSatisfy(Number.isInteger);"],
      ],
      [
        args: ['type Subject = Expect<2, ">", 1>;'],
        expected: ["expect(2).toBeGreaterThan(1);"],
      ],
      [
        args: ['type Subject = Expect<1, ["~=", 0.5], 1.2>;'],
        expected: ["expect(Math.abs(1 - 1.2)).toBeLessThanOrEqual(0.5);"],
      ],
      [
        args: ['type Subject = Expect<"x", "matches", "/x+/i">;'],
        expected: ['expect("x").toMatch(/x+/i);'],
      ],
      [
        args: ['type Subject = Expect<{ a: 1 }, "matches", { a: 1 }>;'],
        expected: ["expect({ a: 1 }).toMatchObject({ a: 1 });"],
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot<"named">>;'],
        expected: ['expect(1).toMatchSnapshot("named");'],
      ],
      [
        args: ['type Subject = Expect<1, "=", Snapshot>;'],
        expected: ["expect(1).toMatchSnapshot();"],
      ],
      /** an ordering condition on something that is not a number compares directly */
      [
        args: ['type Subject = Expect<"b", ">", "a">;'],
        expected: ['expect("b" > "a").toBe(true);'],
      ],
    ]
  >;
}

/** A `"matches"` pattern as a regex: `"/x/i"` is written as one, anything else is a source string. */
export const regex = (e: Expr) => {
  const m = e.kind === "string" && /^\/(.*)\/([a-z]*)$/.exec(e.value);
  return m ? `/${m[1]}/${m[2]}` : `new RegExp(${printExpr(e)})`;
};

declare namespace regex {
  /** a "/…/" string is a regex literal; anything else is a source string, escaped once */
  export type Cases = Table<
    typeof regex,
    [
      [
        args: [pattern: { kind: "string"; value: "/a+/gi" }],
        expected: "/a+/gi",
      ],
      [
        args: [pattern: { kind: "string"; value: "^\\d+$" }],
        expected: 'new RegExp("^\\\\d+$")',
      ],
      [
        args: [pattern: { kind: "name"; name: "Pattern" }],
        expected: "new RegExp(Pattern)",
      ],
    ]
  >;
}

/**
 * Is this `throws` expectation asserted as a *rejected promise* rather than as
 * a function that throws where it stands?
 *
 * An awaited subject has to be, since what it throws arrives as a rejection.
 * So does a `ThrowsMatcher` literal, whatever the subject: it compiles to a
 * predicate over the error, and `.rejects` is the only thing that hands the
 * error to one — `toThrow` takes a class, a message or a pattern, never a
 * predicate.
 */
const rejectsFor = (a: Assertion) =>
  awaits(a.actual) || throwsChain(a.expected).matcher !== "toThrow";

/** The matcher for a `throws` expectation: nothing, a class or message, or a `ThrowsMatcher` literal. */
const throwsChain = (expected: Expr | null): Chain => {
  if (!expected || printExpr(expected) === "undefined")
    return chain("toThrow", []);
  if (expected.kind !== "object")
    return chain("toThrow", [printExpr(expected)]);
  const checks = expected.entries.map(([key, value]) => {
    const v = printExpr(value);
    switch (key) {
      case "instanceOf":
        return `err instanceof ${v}`;
      case "name":
        return `err.name === ${v}`;
      case "message":
        return `String(err.message).includes(${v})`;
      case "matches":
        return `${regex(value)}.test(String(err.message))`;
      default:
        return "false";
    }
  });
  return chain("toSatisfy", [`(err) => ${checks.join(" && ")}`]);
};

// ── statements ──────────────────────────────────────────────────────────────

/** One assertion, as statements: a hoisted expected value when one is needed, then the `expect`. */
export function printAssertion(a: Assertion): string[] {
  const { condition: op, display, soft } = a;
  const expectFn = !display && soft ? "expect.soft" : "expect";
  const actual =
    op === "throws"
      ? `${rejectsFor(a) ? "async " : ""}() => (${printExpr(a.actual)})`
      : // typed array vs tuple: compare as plain arrays
        (op === "=" || op === "!=") &&
          a.shape === "typedArray" &&
          a.expected?.kind === "array"
        ? `Array.from(${printExpr(a.actual)})`
        : printExpr(a.actual);
  const pre: string[] = [];
  let expected = a.expected ? printExpr(a.expected) : "undefined";
  // an expected value that awaits cannot sit inside a callback: hoist it
  if (
    a.expected &&
    awaits(a.expected) &&
    (display || op === "satisfies" || op === "some" || op === "every")
  ) {
    pre.push(`const expected = ${expected};`);
    expected = "expected";
  }
  const c = matchers[op](a, {
    actual,
    expected,
    param: a.param ? printExpr(a.param) : "undefined",
  });
  const text = printChain(c);
  // a derived subject is asserted on directly — ntCheck only ever sees the real one
  if (c.subject !== undefined)
    return [...pre, `${expectFn}(${c.subject})${text};`];
  if (display)
    // ntCheck runs the same matcher, and records what it saw on task.meta for the IDE
    return [
      ...pre,
      `await ntCheck(task, { display: ${quote(display.page)}, meta: ${display.meta ? printExpr(display.meta) : "undefined"}, soft: ${soft} }, async () => ${actual}, ${expected}, (actual) => ${expectFn}(actual)${text});`,
    ];
  const statement = `${expectFn}(${actual})${text};`;
  return [...pre, c.rejects ? `await ${statement}` : statement];
}

export const printStatement = (s: Statement): string[] =>
  s.kind === "effect" ? [`${printExpr(s.expr)};`] : printAssertion(s);

const printParam = (p: Param) =>
  `${p.name}: ${p.type}${p.fallback ? ` = ${printExpr(p.fallback)}` : ""}`;

const printBinding = (b: Binding) =>
  b.params
    ? // an object literal as an arrow's body reads as a block: parenthesise it
      `const ${b.name} = ${awaits(b.value) ? "async " : ""}(${b.params.map(printParam).join(", ")}) => ${b.value.kind === "object" ? `(${printExpr(b.value)})` : printExpr(b.value)};`
    : `const ${b.name}${b.annotation ? `: ${b.annotation}` : ""} = ${printExpr(b.value)};`;

// ── tests ───────────────────────────────────────────────────────────────────

/** Helpers the generated module must import or declare for a test to run. */
export type Needs = {
  /** `readFileSync`, for `FromFile`. */
  fs: boolean;
  /** `nt_env`, for an `Env` with no default. */
  env: boolean;
  /** `ntCheck` and the `{ task }` parameter, for a display page. */
  task: boolean;
  /** `nt_unsupported`, for what could not be materialised. */
  unsupported: boolean;
  /** Value re-imports of type-only bindings: specifier → `a as a$`… */
  imports: Map<string, Set<string>>;
};

/** What one test needs, read off its IR in one walk. */
export function needsOf(t: TestCase): Needs {
  const needs: Needs = {
    fs: false,
    env: false,
    task: t.body.some((s) => s.kind === "assert" && !!s.display),
    unsupported: false,
    imports: t.imports,
  };
  const visit = (e: Expr): void => {
    if (e.kind === "file") needs.fs = true;
    else if (e.kind === "env" && !e.fallback) needs.env = true;
    else if (e.kind === "unsupported") needs.unsupported = true;
    children(e).forEach(visit);
  };
  t.bindings.forEach((b) => {
    b.params?.forEach((p) => p.fallback && visit(p.fallback));
    visit(b.value);
  });
  t.body.flatMap(exprsOf).forEach(visit);
  return needs;
}

/** The union of what several tests need: what their shared preamble must provide. */
export function allNeeds(needs: Needs[]): Needs {
  const imports = new Map<string, Set<string>>();
  for (const n of needs)
    for (const [spec, names] of n.imports)
      imports.set(spec, new Set([...(imports.get(spec) ?? []), ...names]));
  return {
    fs: needs.some((n) => n.fs),
    env: needs.some((n) => n.env),
    task: needs.some((n) => n.task),
    unsupported: needs.some((n) => n.unsupported),
    imports,
  };
}

/** One generated test: a top-level `test(…)`, every line anchored to the source. */
export type EmittedTest = TestCase & {
  /** The generated lines, each anchored to the line it came from. */
  lines: Line[];
  /** `lines` joined: the test's source. */
  code: string;
  needs: Needs;
};

/**
 * Does this statement print an `await`? Either something in it is awaited, or
 * it is a rejection: `.rejects` is awaited however its subject was written.
 */
const statementAwaits = (s: Statement) =>
  exprsOf(s).some(awaits) ||
  (s.kind === "assert" && s.condition === "throws" && rejectsFor(s));

/**
 * Does the test have to be an async function? Only if something in it is
 * awaited: a statement, a `const` binding of its own, or `ntCheck`, which is
 * always awaited. A generic alias that awaits carries its own `async`, so it
 * says nothing about the test around it.
 */
const isAsync = (t: TestCase, needs: Needs) =>
  needs.task ||
  t.bindings.some((b) => !b.params && awaits(b.value)) ||
  t.body.some(statementAwaits);

export function printTest(t: TestCase): EmittedTest {
  const needs = needsOf(t);
  const doc: Line[] = t.doc
    ? [{ code: `/** ${t.doc.text.replace(/\n/g, " ")} */`, line: t.doc.line }]
    : [];
  const lines: Line[] =
    t.mode === "test.todo"
      ? [...doc, { code: `test.todo(${quote(t.name)});`, line: t.line }]
      : [
          ...doc,
          {
            code: `${t.mode}(${quote(t.name)}${Object.keys(t.options).length ? `, ${JSON.stringify(t.options)}` : ""}, ${isAsync(t, needs) ? "async " : ""}(${needs.task ? "{ task }" : ""}) => {`,
            line: t.line,
          },
          ...t.bindings.map((b) => ({
            code: `  ${printBinding(b)}`,
            line: b.line,
          })),
          ...t.body.flatMap((s) =>
            printStatement(s).map((code) => ({
              code: `  ${code}`,
              line: s.line,
            })),
          ),
          { code: `});`, line: t.line },
        ];
  return { ...t, lines, code: lines.map((l) => l.code).join("\n"), needs };
}

/** The preamble of a generated module: the Vitest import, plus whatever the tests need. */
export function headerLines(needs: Needs, runtime: string): string[] {
  const valueImport = (n: string, spec: string) =>
    `import ${n} from ${quote(spec)}; // value import: the original import is type-only`;
  const lines = [
    `// ───────── generated by namespace-tests; not part of your build ─────────`,
    `import { test, expect } from "vitest";`,
    needs.task && `import { ntCheck } from ${quote(runtime)};`,
    needs.fs && `import { readFileSync } from "node:fs";`,
    ...[...needs.imports].flatMap(([spec, names]) => {
      const namespace = [...names].filter((n) => n.startsWith("* as "));
      const named = [...names].filter((n) => !n.startsWith("* as "));
      return [
        ...namespace.map((n) => valueImport(n, spec)),
        named.length > 0 && valueImport(`{ ${named.join(", ")} }`, spec),
      ];
    }),
    needs.unsupported &&
      "const nt_unsupported = (t: string) => { throw new Error(`namespace-tests: cannot materialize \\`${t}\\``); };",
    needs.env &&
      "const nt_env = (n: string) => { if (process.env[n] === undefined) throw new Error(`namespace-tests: env var ${n} is not set`); return process.env[n]!; };",
  ];
  return lines.filter((l): l is string => typeof l === "string");
}
