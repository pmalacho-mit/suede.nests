// A test, in shorthand: what is set up, what is done, and what is claimed of
// what comes back, as a few lines of code a programmer reads at a glance. It is
// read off the printer's IR, so it says exactly what the printed test checks,
// and nothing the test does not.
//
//   Run = spy()
//   Debounced = debounce(run: Run, ms: 100)
//   fakeTimers()
//   Debounced()  // ×3
//   advanceTimers(100)
//   calls(Run).length → 1
//
// It is the *evidence*, not the claim. The claim is the `/** … */` a person
// wrote above the test, which says why; this says what. It is shorter than the
// DSL and than the Vitest it prints: the values are written as code, and only
// a condition no operator says is said in a word (`is empty`, `throws`,
// `was called with`). A harness function with a JSDoc that names its
// parameters keeps those words, filled in, as a comment on its line.
import { printExpr } from "../vite-plugin/emit/print.mts";
import { awaits } from "../vite-plugin/emit/ir.mts";

import type {
  Assertion,
  Binding,
  ConditionName,
  Expr,
  ModuleMock,
  Setup,
  TestCase,
} from "../vite-plugin/emit/ir.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";
import type * as harness from "../_internal/harness.mts";

/** What a callee says of itself: its JSDoc, and its parameters' names. */
export type Callee = { doc: string | null; params: string[] };

/** Finds what a name in the test refers to. */
export type Lookup = (name: string) => Callee | null;

// what a line says beside its code: a harness function's own words, a repeat count
type Scope = { lookup: Lookup; notes: string[] };

type Name = Extract<Expr, { kind: "name" }>;

// as the test wrote it: a re-imported harness function prints under another name
const written = (e: Name) => (e.imported ? e.imported.name : e.name);

const quote = (s: string) => JSON.stringify(s);

const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

const propKey = (name: string) => (isIdentifier(name) ? name : quote(name));

const member = (key: string) =>
  isIdentifier(key) ? `.${key}` : `[${quote(key)}]`;

const isData = (e: Expr): boolean =>
  e.kind === "string" ||
  e.kind === "literal" ||
  (e.kind === "array" && e.elements.every(isData)) ||
  (e.kind === "object" && e.entries.every(([, v]) => isData(v)));

// `A branch-shaped name of `length` characters: …` with `length` given 200 is
// "a branch-shaped name of 200 characters": the callee's own words, when every
// name they mention is one of its parameters
export function templated(
  callee: Callee | null,
  values: string[],
): string | null {
  if (!callee?.doc) return null;
  const clause = callee.doc
    .split(/[:;]\s|\.(?:\s|$)|\n\n/)[0]!
    .replace(/\s+/g, " ")
    .trim();
  if (!clause) return null;
  const mentioned = [...clause.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  // every name it mentions is a parameter, and every parameter given a value is mentioned
  const given = callee.params.slice(0, values.length);
  if (
    !mentioned.every((name) => callee.params.includes(name)) ||
    !given.every((p) => mentioned.includes(p))
  )
    return null;
  const filled = clause.replace(
    /`([^`]+)`/g,
    (_, name: string) => values[callee.params.indexOf(name)] ?? name,
  );
  return filled.charAt(0).toLowerCase() + filled.slice(1);
}

declare namespace templated {
  /** the callee's first clause, with each parameter it names replaced by its value */
  export type Fills = Table<
    typeof templated,
    [
      [
        args: [
          callee: {
            doc: "A branch-shaped name of `length` characters: `b` and then `x`s.";
            params: ["length"];
          },
          values: ["200"],
        ],
        expected: "a branch-shaped name of 200 characters",
      ],
      [
        args: [
          callee: {
            doc: "The home, emptied: no state, no domains.";
            params: [];
          },
          values: [],
        ],
        expected: "the home, emptied",
      ],
      /** a name the doc mentions that is not a parameter means the words are not a template */
      [
        args: [
          callee: { doc: "Calls `run` after `ms`."; params: ["run"] },
          values: ["f"],
        ],
        expected: null,
      ],
      [args: [callee: { doc: null; params: [] }, values: []], expected: null],
    ]
  >;
}

type Applied = Extract<Expr, { kind: "call" | "construct" | "method" }>;

// one argument is plain; with more, each is named as the tuple or the parameter names it
const argumentsOf = (e: Applied, scope: Scope) =>
  e.args
    .map((a, i) => {
      const value = expression(a, scope);
      const label = e.args.length > 1 ? e.labels?.[i] : null;
      return label ? `${label}: ${value}` : value;
    })
    .join(", ");

// only a harness function, imported as a type and re-imported to run, says
// what it does in its own words, beside the call
function noteOwnWords(e: Extract<Expr, { kind: "call" }>, scope: Scope) {
  if (e.callee.kind !== "name" || !e.callee.imported) return;
  const said = templated(
    scope.lookup(e.callee.imported.name),
    e.args.map((a) => expression(a, { ...scope, notes: [] })),
  );
  if (said) scope.notes.push(said);
}

const templateText = (text: string) =>
  text.replace(/[\\`]|\$\{/g, (m) => `\\${m}`);

/** An expression, as code. */
export function expression(
  e: Expr,
  scope: Scope = { lookup: () => null, notes: [] },
): string {
  if (isData(e)) return printExpr(e);
  switch (e.kind) {
    case "array":
      return `[${e.elements.map((x) => expression(x, scope)).join(", ")}]`;
    case "object":
      return e.entries.length
        ? `{ ${e.entries.map(([k, v]) => `${propKey(k)}: ${expression(v, scope)}`).join(", ")} }`
        : "{}";
    case "name":
      return written(e);
    case "call":
      noteOwnWords(e, scope);
      return `${expression(e.callee, scope)}(${argumentsOf(e, scope)})`;
    // `new C().m()` is already read as `(new C()).m()`: only a computed class needs parentheses
    case "construct":
      return `new ${e.callee.kind === "name" ? written(e.callee) : `(${expression(e.callee, scope)})`}(${argumentsOf(e, scope)})`;
    case "method":
      return `${expression(e.receiver, scope)}${member(e.method)}(${argumentsOf(e, scope)})`;
    case "index":
      return typeof e.key === "number"
        ? `${expression(e.object, scope)}[${e.key}]`
        : `${expression(e.object, scope)}${member(e.key)}`;
    case "file":
      return `${e.format === "json" ? "readJSON" : e.format === "bytes" ? "readBytes" : "readFile"}(${expression(e.path, scope)})`;
    case "env":
      return e.fallback
        ? `(env${member(e.name)} ?? ${expression(e.fallback, scope)})`
        : `env${member(e.name)}`;
    case "snapshot":
      return "snapshot";
    // the type needed them (`(typeof x)["k"]`); the code does not
    case "paren":
      return expression(e.inner, scope);
    case "mocked":
      return expression(e.inner, scope);
    case "caught":
      return `${e.awaited ? "rejection" : "thrown"}(${expression(e.inner, scope)})`;
    case "spy":
      return `spy(${e.impl ? expression(e.impl, scope) : ""})`;
    case "calls":
      return `calls(${expression(e.spy, scope)})`;
    case "tempDir":
      return e.files.kind === "object" && !e.files.entries.length
        ? "tempDir()"
        : `tempDir(${expression(e.files, scope)})`;
    case "exists":
      return `exists(${expression(e.path, scope)})`;
    case "listDir":
      return `listDir(${expression(e.path, scope)})`;
    case "repeat":
      return `${expression(e.text, scope)}.repeat(${expression(e.count, scope)})`;
    case "template":
      return `\`${templateText(e.head)}${e.spans.map(([value, text]) => `\${${expression(value, scope)}}${templateText(text)}`).join("")}\``;
    case "advanceTimers":
      return `advanceTimers(${expression(e.ms, scope)})`;
    case "writeFile":
      return `writeFile(${expression(e.path, scope)}, ${expression(e.text, scope)})`;
    case "unsupported":
      scope.notes.push("cannot be run");
      return e.source;
    default:
      return printExpr(e);
  }
}

declare namespace expression {
  /** a call is the call; its arguments are named once there is more than one */
  export type Calls = Table<
    typeof harness.shorthandExpression,
    [
      [
        args: [
          source: "const add = (a: number, b: number) => a + b;\ntype Subject = Invoke<typeof add, [a: 1, b: 2]>;",
        ],
        expected: "add(a: 1, b: 2)",
      ],
      /** unnamed, an argument is called what the parameter it lands in is called */
      [
        args: [
          source: "const add = (a: number, b: number) => a + b;\ntype Subject = Invoke<typeof add, [1, 2]>;",
        ],
        expected: "add(a: 1, b: 2)",
      ],
      /** a single argument needs no name: the function's own says what it is */
      [
        args: [
          source: "const twice = (n: number) => n * 2;\ntype Subject = Invoke<typeof twice, [n: 3]>;",
        ],
        expected: "twice(3)",
      ],
      [
        args: [
          source: "class C { constructor(n: number) {} }\ntype Subject = Construct<typeof C, [n: 3]>;",
        ],
        expected: "new C(3)",
      ],
    ]
  >;

  /** the values a harness module was needed for read as calls that say what they are */
  export type BeyondLiterals = Table<
    typeof harness.shorthandExpression,
    [
      [
        args: [
          source: 'type Run = Spy<() => void>;\ntype Subject = Calls<Run>["length"];',
        ],
        expected: "calls(Run).length",
      ],
      [
        args: [
          source: 'type Subject = TempDir<{ "a.txt": "x"; "b/c.json": "{}" }>;',
        ],
        expected: 'tempDir({ "a.txt": "x", "b/c.json": "{}" })',
      ],
      [
        args: [
          source: "type Dir = TempDir;\ntype Subject = FromFile<`${Dir}/out.txt`>;",
        ],
        expected: "readFile(`${Dir}/out.txt`)",
      ],
      [
        args: [source: 'type Subject = `b${Repeat<"x", 199>}`;'],
        expected: '`b${"x".repeat(199)}`',
      ],
      [
        args: [
          source: 'const f = (x: number) => x;\ntype Subject = Caught<Invoke<typeof f, [x: 1]>>["message"];',
        ],
        expected: "thrown(f(1)).message",
      ],
    ]
  >;
}

// `throws RangeError { message: /integer/, code: 64 }`: what is thrown, as the
// pattern its fields match; a message the error contains is a regex for it
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const contains = (e: Expr, scope: Scope) =>
  e.kind === "string" ? `/${escaped(e.value)}/` : expression(e, scope);

// `"/…/i"` is a regex already; any other string is a regex's source
const pattern = (e: Expr, scope: Scope) => {
  if (e.kind !== "string") return expression(e, scope);
  const literal = /^\/(.*)\/([a-z]*)$/.exec(e.value);
  return literal ? e.value : `/${e.value.replace(/\//g, "\\/")}/`;
};

function thrown(expected: Expr | null, scope: Scope): string {
  // `Throws<X>` expects nothing, which lowers to `undefined`
  if (
    !expected ||
    (expected.kind === "literal" && expected.source === "undefined")
  )
    return "";
  if (expected.kind === "string") return ` ${contains(expected, scope)}`;
  if (expected.kind !== "object") return ` ${expression(expected, scope)}`;
  const cls = expected.entries.find(([k]) => k === "instanceOf");
  const fields = expected.entries
    .filter(([k]) => k !== "instanceOf")
    .map(([k, v]) =>
      k === "message"
        ? `message: ${contains(v, scope)}`
        : k === "matches"
          ? `message: ${pattern(v, scope)}`
          : `${propKey(k)}: ${expression(v, scope)}`,
    );
  return [
    "",
    ...(cls ? [expression(cls[1], scope)] : []),
    ...(fields.length ? [`{ ${fields.join(", ")} }`] : []),
  ].join(" ");
}

// the operands of a claim, as code: the actual, and what it is held to
type Operands = { x: string; y: string };

const CONDITIONS: Record<
  ConditionName,
  (o: Operands, a: Assertion, scope: Scope) => string
> = {
  "=": ({ x, y }, a, scope) =>
    a.expected?.kind === "snapshot"
      ? `${x} matches its snapshot${a.expected.name ? ` ${expression(a.expected.name, scope)}` : ""}`
      : `${x} → ${y}`,
  "!=": ({ x, y }) => `${x} ≠ ${y}`,
  is: ({ x, y }) => `${x} === ${y}`,
  isNot: ({ x, y }) => `${x} !== ${y}`,
  satisfies: ({ x, y }) => `${x} satisfies ${y}`,
  instanceOf: ({ x, y }) => `${x} instanceof ${y}`,
  truthy: ({ x }) => `${x} is truthy`,
  falsy: ({ x }) => `${x} is falsy`,
  defined: ({ x }) => `${x} !== undefined`,
  undefined: ({ x }) => `${x} === undefined`,
  throws: ({ x }, a, scope) =>
    `${x} ${awaits(a.actual) ? "rejects" : "throws"}${thrown(a.expected, scope)}`,
  ">": ({ x, y }) => `${x} > ${y}`,
  ">=": ({ x, y }) => `${x} >= ${y}`,
  "<": ({ x, y }) => `${x} < ${y}`,
  "<=": ({ x, y }) => `${x} <= ${y}`,
  "~=": ({ x, y }, a, scope) =>
    `${x} ≈ ${y} ± ${a.param ? expression(a.param, scope) : "?"}`,
  includes: ({ x, y }) => `${x}.includes(${y})`,
  excludes: ({ x, y }) => `!${x}.includes(${y})`,
  startsWith: ({ x, y }) => `${x}.startsWith(${y})`,
  endsWith: ({ x, y }) => `${x}.endsWith(${y})`,
  matches: ({ x, y }, a, scope) =>
    a.shape === "string" && a.expected
      ? `${x} matches ${pattern(a.expected, scope)}`
      : `${x} matches ${y}`,
  some: ({ x, y }) => `${x}.some(${y})`,
  every: ({ x, y }) => `${x}.every(${y})`,
  isEmpty: ({ x }) => `${x} is empty`,
  isNotEmpty: ({ x }) => `${x} is not empty`,
  hasKey: ({ x, y }) => `${x} has key ${y}`,
  lacksKey: ({ x, y }) => `${x} lacks key ${y}`,
  isNaN: ({ x }) => `isNaN(${x})`,
  isInteger: ({ x }) => `Number.isInteger(${x})`,
  isFinite: ({ x }) => `Number.isFinite(${x})`,
};

// some claims read better with the subject as the verb: "`Run` was never called", "`a.txt` exists"
function idiom(a: Assertion, scope: Scope): string | null {
  const { actual, condition, expected } = a;
  if (actual.kind === "calls") {
    const spy = expression(actual.spy, scope);
    if (condition === "isEmpty") return `${spy} was never called`;
    if (condition === "isNotEmpty") return `${spy} was called`;
    if (condition === "=" && expected?.kind === "array") {
      const calls = expected.elements.map((call) =>
        call.kind === "array"
          ? `(${call.elements.map((x) => expression(x, scope)).join(", ")})`
          : expression(call, scope),
      );
      return calls.length
        ? `${spy} was called with ${calls.join(", then ")}`
        : `${spy} was never called`;
    }
  }
  if (
    actual.kind === "exists" &&
    (condition === "truthy" || condition === "falsy")
  )
    return `${expression(actual.path, scope)} ${condition === "truthy" ? "exists" : "does not exist"}`;
  return null;
}

const assertionLine = (a: Assertion, scope: Scope) =>
  idiom(a, scope) ??
  CONDITIONS[a.condition](
    {
      x: expression(a.actual, scope),
      y: a.expected ? expression(a.expected, scope) : "",
    },
    a,
    scope,
  );

const setupLine = (s: Setup, scope: Scope) =>
  s.kind === "fakeTimers"
    ? `fakeTimers(${s.now ? expression(s.now, scope) : ""})`
    : s.value
      ? `env${member(s.name)} = ${expression(s.value, scope)}`
      : `delete env${member(s.name)}`;

const mockLine = (m: ModuleMock) =>
  `mock(${quote(m.path)}${m.replacement ? `, ${m.replacement.name}` : ""})`;

// `Parsed = (S) => parse(S)`: an alias with type parameters is a function of them
const bindingLine = (b: Binding, scope: Scope) =>
  `${b.name} = ${b.params ? `(${b.params.map((p) => p.name).join(", ")}) => ` : ""}${expression(b.value, scope)}`;

type Line = { code: string; notes: string[] };

const line = (lookup: Lookup, render: (scope: Scope) => string): Line => {
  const scope: Scope = { lookup, notes: [] };
  const code = render(scope);
  return { code, notes: scope.notes };
};

// the same line three times running is written once, with its count
const counted = (lines: Line[]): Line[] => {
  const out: Line[] = [];
  for (let i = 0; i < lines.length; ) {
    let n = 1;
    while (
      lines[i + n] &&
      lines[i + n]!.code === lines[i]!.code &&
      lines[i + n]!.notes.join() === lines[i]!.notes.join()
    )
      n++;
    const { code, notes } = lines[i]!;
    out.push({ code, notes: n > 1 ? [...notes, `×${n}`] : notes });
    i += n;
  }
  return out;
};

const text = ({ code, notes }: Line) =>
  notes.length ? `${code}  // ${notes.join("; ")}` : code;

/** A test, in shorthand: a line per mock, setup, alias, effect and claim, in the order they run. */
export function shorthand(t: TestCase, lookup: Lookup = () => null): string[] {
  if (t.mode === "test.todo") return [];
  const at = (render: (scope: Scope) => string) => line(lookup, render);
  const effects: Line[] = [];
  const claims: Line[] = [];
  for (const s of t.body)
    if (s.kind === "effect")
      effects.push(at((scope) => expression(s.expr, scope)));
    else claims.push(at((scope) => assertionLine(s, scope)));
  return [
    ...t.mocks.map((m) => at(() => mockLine(m))),
    ...t.setup.map((s) => at((scope) => setupLine(s, scope))),
    ...t.bindings.map((b) => at((scope) => bindingLine(b, scope))),
    ...counted(effects),
    ...(claims.length ? claims : [{ code: "// nothing is checked", notes: [] }]),
  ].map(text);
}

declare namespace shorthand {
  /** one claim on one call: the call, then what it comes to */
  export type Plain = Expect<
    Invoke<
      typeof harness.shorthandOf,
      [
        'const add = (a: number, b: number) => a + b;\ndeclare namespace add { export type T = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>; }',
        "T",
      ]
    >,
    "=",
    [["add(a: 4, b: 5) → 9"]]
  >;

  type Debounce = `
    const debounce = (run: () => void, ms: number) => () => { setTimeout(run, ms); };
    declare namespace debounce {
      type Run = Spy<() => void>;
      type D = Invoke<typeof debounce, [run: Run, ms: 100]>;
      export type T = Given<[FakeTimers, Invoke<D>, Invoke<D>, AdvanceTimers<100>], Expect<Calls<Run>["length"], "=", 1>>;
    }
  `;

  /** setup, then the aliases, then each effect once with how often it ran, then the claim */
  export type Effects = Expect<
    Invoke<typeof harness.shorthandOf, [Debounce, "T"]>,
    "=",
    [
      [
        "fakeTimers()",
        "Run = spy()",
        "D = debounce(run: Run, ms: 100)",
        "D()  // ×2",
        "advanceTimers(100)",
        "calls(Run).length → 1",
      ],
    ]
  >;

  type Visits = `
    const each = (xs: number[], visit: (x: number) => void) => xs.forEach((x) => visit(x));
    declare namespace each {
      type Visit = Spy<(x: number) => void>;
      export type T = Given<Invoke<typeof each, [xs: [1, 2], visit: Visit]>, Expect<Calls<Visit>, "=", [[1], [2]]>>;
      export type None = Given<Invoke<typeof each, [xs: [], visit: Visit]>, Expect<Calls<Visit>, "isEmpty">>;
    }
  `;

  /** what a spy was handed reads as the calls it got */
  export type Called = [
    Expect<
      Invoke<typeof harness.shorthandOf, [Visits, "T"]>,
      "=",
      [
        [
          "Visit = spy()",
          "each(xs: [1, 2], visit: Visit)",
          "Visit was called with (1), then (2)",
        ],
      ]
    >,
    Expect<
      Invoke<typeof harness.shorthandOf, [Visits, "None"]>,
      "=",
      [
        [
          "Visit = spy()",
          "each(xs: [], visit: Visit)",
          "Visit was never called",
        ],
      ]
    >,
  ];

  type Refuses = `
    class Refusal extends Error { code = 64; }
    const parse = (text: string): number => { throw new Refusal(text); };
    declare namespace parse {
      export type T = Throws<Invoke<typeof parse, [text: "x"]>, { instanceOf: Refusal; code: 64 }>;
      export type M = Throws<Invoke<typeof parse, [text: "x.y"]>, "x.y">;
      export type R = Throws<Invoke<typeof parse, [text: "x"]>, { matches: "^x$" }>;
    }
  `;

  /** a refusal says what is thrown, as the pattern its fields match; a message it contains is a regex for it */
  export type Thrown = [
    Expect<
      Invoke<typeof harness.shorthandOf, [Refuses, "T"]>,
      "=",
      [['parse("x") throws Refusal { code: 64 }']]
    >,
    Expect<
      Invoke<typeof harness.shorthandOf, [Refuses, "M"]>,
      "=",
      [['parse("x.y") throws /x\\.y/']]
    >,
    Expect<
      Invoke<typeof harness.shorthandOf, [Refuses, "R"]>,
      "=",
      [['parse("x") throws { message: /^x$/ }']]
    >,
  ];

  type Strings = `
    const slug = (s: string) => s;
    declare namespace slug {
      export type Ends = [
        Expect<Invoke<typeof slug, ["--a--"]>, "startsWith", "-">,
        Expect<Invoke<typeof slug, ["--a--"]>, "excludes", "b">,
        Expect<Invoke<typeof slug, ["--a--"]>["length"], "<=", 5>,
        Expect<Invoke<typeof slug, ["--a--"]>, "matches", "^[a-z/-]*$">,
        Expect<Invoke<typeof slug, [""]>, "isEmpty">,
      ];
    }
  `;

  /** a condition is an operator or a method where code has one, and a word only where it has none */
  export type Conditions = Expect<
    Invoke<typeof harness.shorthandOf, [Strings, "Ends"]>,
    "=",
    [
      [
        'slug("--a--").startsWith("-")',
        '!slug("--a--").includes("b")',
        'slug("--a--").length <= 5',
        'slug("--a--") matches /^[a-z\\/-]*$/',
        'slug("") is empty',
      ],
    ]
  >;
}

// ── as Markdown ────────────────────────────────────────────────────────────

/** Code as a Markdown code span, fenced by more backticks than it holds. */
export const codeSpan = (text: string) => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = "`".repeat(longest + 1);
  const pad = longest ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

declare namespace codeSpan {
  /** a template literal's backticks are held by a longer fence */
  export type Fences = Table<
    typeof codeSpan,
    [
      [args: ["f(1) → 2"], expected: "`f(1) → 2`"],
      [args: ["readFile(`${Dir}/a`)"], expected: "`` readFile(`${Dir}/a`) ``"],
    ]
  >;
}

/** Shorthand lines as a fenced `ts` block, each line indented by `indent`. */
export const codeBlock = (lines: string[], indent = "") => {
  const longest = Math.max(
    2,
    ...lines.flatMap((l) => [...l.matchAll(/`+/g)].map((m) => m[0].length)),
  );
  const fence = "`".repeat(longest + 1);
  return [`${fence}ts`, ...lines, fence].map((l) => `${indent}${l}`);
};
