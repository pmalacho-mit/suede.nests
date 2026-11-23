// A test, said in words: what is set up, what is done, and what is claimed of
// what comes back. It is read off the printer's IR, so it says exactly what the
// printed test checks, and nothing the test does not.
//
// It is the *evidence* in words, not the claim. The claim is the `/** … */` a
// person wrote above the test, which says why; this says what. A reader who
// does not read the DSL gets the what from here, and the docs set the two side
// by side. (See the API reference, "Saying a test in words".)
import { MATCHER_FIELDS, printExpr } from "../vite-plugin/emit/print.mts";
import { awaits } from "../vite-plugin/emit/ir.mts";

import type {
  Assertion,
  Binding,
  ConditionName,
  Expr,
  ModuleMock,
  Setup,
  Statement,
  TestCase,
} from "../vite-plugin/emit/ir.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";
import type * as harness from "../_internal/harness.mts";

/** What a callee says of itself: its JSDoc, and its parameters' names. */
export type Callee = { doc: string | null; params: string[] };

/** Finds what a name in the test refers to. */
export type Lookup = (name: string) => Callee | null;

export type Description = {
  /** One sentence: the setup, the effects, then each claim on what came back. */
  sentence: string;
  /** What each alias the test names stands for: "`Run` is a recorded function". */
  where: string[];
};

const code = (text: string) => `\`${text}\``;

type Name = Extract<Expr, { kind: "name" }>;

// as the test wrote it: a re-imported harness function prints under another name
const written = (e: Name) => (e.imported ? e.imported.name : e.name);

const isData = (e: Expr): boolean =>
  e.kind === "string" ||
  e.kind === "literal" ||
  (e.kind === "array" && e.elements.every(isData)) ||
  (e.kind === "object" && e.entries.every(([, v]) => isData(v)));

const listed = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

type Scope = { lookup: Lookup };

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

const argumentsOf = (
  args: Expr[],
  labels: (string | null)[] | undefined,
  scope: Scope,
) =>
  listed(
    args.map((a, i) =>
      labels?.[i] ? `${labels[i]} ${phrase(a, scope)}` : phrase(a, scope),
    ),
  );

// a callee as code: the name the test wrote, or the expression it is
const calleeText = (e: Expr) => (e.kind === "name" ? written(e) : printExpr(e));

const calleeName = (e: Expr) =>
  e.kind === "name" ? code(written(e)) : phrase(e, { lookup: () => null });

// only a harness function, imported as a type and re-imported to run, speaks in its own
// words: the function under test is named, so the reader sees exactly what is called
const ownWords = (e: Extract<Expr, { kind: "call" }>, scope: Scope) =>
  e.callee.kind === "name" && e.callee.imported
    ? templated(
        scope.lookup(e.callee.imported.name),
        e.args.map((a) => phrase(a, scope)),
      )
    : null;

type Applied = Extract<Expr, { kind: "call" | "construct" | "method" }>;

// "`f` given a `1` and b `2`", or with another verb; nothing after the name when there are no arguments
const withArgs = (name: string, e: Applied, verb: string, scope: Scope) =>
  e.args.length
    ? `${name} ${verb} ${argumentsOf(e.args, e.labels, scope)}`
    : name;

const methodName = (e: Extract<Expr, { kind: "method" }>, scope: Scope) =>
  e.receiver.kind === "name"
    ? code(`${written(e.receiver)}.${e.method}`)
    : `${code(e.method)} of ${phrase(e.receiver, scope)}`;

/** An expression, as a noun phrase. */
export function phrase(e: Expr, scope: Scope = { lookup: () => null }): string {
  if (isData(e)) return code(printExpr(e));
  switch (e.kind) {
    case "array":
      return `[${e.elements.map((x) => phrase(x, scope)).join(", ")}]`;
    case "object":
      return `{ ${e.entries.map(([k, v]) => `${k}: ${phrase(v, scope)}`).join(", ")} }`;
    case "name":
      return code(written(e));
    case "call":
      return (
        ownWords(e, scope) ??
        (e.args.length
          ? withArgs(calleeName(e.callee), e, "given", scope)
          : code(`${calleeText(e.callee)}()`))
      );
    case "construct":
      return `a new ${withArgs(calleeName(e.callee), e, "given", scope)}`;
    case "method":
      return e.args.length
        ? withArgs(methodName(e, scope), e, "given", scope)
        : `${methodName(e, scope)}()`;
    case "index":
      if (e.key === "length")
        return e.object.kind === "calls"
          ? `how many times ${phrase(e.object.spy, scope)} was called`
          : `the length of ${phrase(e.object, scope)}`;
      return typeof e.key === "number"
        ? `item ${e.key} of ${phrase(e.object, scope)}`
        : `the ${code(e.key)} of ${phrase(e.object, scope)}`;
    case "file":
      return `${e.format === "json" ? "the JSON in" : e.format === "bytes" ? "the bytes of" : "the text of"} ${phrase(e.path, scope)}`;
    case "env":
      return e.fallback
        ? `the variable ${code(e.name)}, or ${phrase(e.fallback, scope)} when it is unset`
        : `the variable ${code(e.name)}`;
    case "snapshot":
      return "its stored snapshot";
    case "paren":
      return phrase(e.inner, scope);
    case "mocked":
      return `${phrase(e.inner, scope)} (mocked)`;
    case "caught":
      return `the error ${phrase(e.inner, scope)} ${e.awaited ? "rejects with" : "throws"}`;
    case "spy":
      return e.impl
        ? `a recorded function that runs ${phrase(e.impl, scope)}`
        : "a recorded function";
    case "calls":
      return `the arguments of each call to ${phrase(e.spy, scope)}`;
    case "tempDir": {
      const files =
        e.files.kind === "object" ? e.files.entries.map(([k]) => code(k)) : [];
      return files.length
        ? `a fresh directory holding ${listed(files)}`
        : "a fresh, empty directory";
    }
    case "exists":
      return `whether ${phrase(e.path, scope)} exists`;
    case "listDir":
      return `what is in ${phrase(e.path, scope)}`;
    case "repeat":
      return `${phrase(e.text, scope)} repeated ${printExpr(e.count)} times`;
    case "template": {
      // `${Dir}/a.txt` is "`a.txt` in `Dir`"
      if (!e.head && e.spans.length === 1) {
        const [[value, text]] = e.spans as [[Expr, string]];
        if (value.kind === "name" && text.startsWith("/"))
          return `${code(text.slice(1))} in ${phrase(value, scope)}`;
      }
      const parts = [
        ...(e.head ? [code(JSON.stringify(e.head))] : []),
        ...e.spans.flatMap(([value, text]) => [
          phrase(value, scope),
          ...(text ? [code(JSON.stringify(text))] : []),
        ]),
      ];
      return parts.join(" then ");
    }
    case "advanceTimers":
      return `fake time moved on ${printExpr(e.ms)} ms`;
    case "writeFile":
      return `${phrase(e.text, scope)} written to ${phrase(e.path, scope)}`;
    case "unsupported":
      return `${code(e.source)}, which cannot be run`;
    default:
      return code(printExpr(e));
  }
}

declare namespace phrase {
  /** a call names what each argument is, as the tuple or the parameter does */
  export type Calls = Table<
    typeof harness.describeExpression,
    [
      [
        args: [
          source: "const add = (a: number, b: number) => a + b;\ntype Subject = Invoke<typeof add, [a: 1, b: 2]>;",
        ],
        expected: "`add` given a `1` and b `2`",
      ],
      /** unnamed, an argument is called what the parameter it lands in is called */
      [
        args: [
          source: "const add = (a: number, b: number) => a + b;\ntype Subject = Invoke<typeof add, [1, 2]>;",
        ],
        expected: "`add` given a `1` and b `2`",
      ],
      [
        args: [
          source: "class C { constructor(n: number) {} }\ntype Subject = Construct<typeof C, [n: 3]>;",
        ],
        expected: "a new `C` given n `3`",
      ],
    ]
  >;

  /** the values a harness module was needed for read as what they are */
  export type BeyondLiterals = Table<
    typeof harness.describeExpression,
    [
      [
        args: [
          source: 'type Run = Spy<() => void>;\ntype Subject = Calls<Run>["length"];',
        ],
        expected: "how many times `Run` was called",
      ],
      [
        args: [
          source: 'type Subject = TempDir<{ "a.txt": "x"; "b/c.json": "{}" }>;',
        ],
        expected: "a fresh directory holding `a.txt` and `b/c.json`",
      ],
      [
        args: [
          source: "type Dir = TempDir;\ntype Subject = FromFile<`${Dir}/out.txt`>;",
        ],
        expected: "the text of `out.txt` in `Dir`",
      ],
      [
        args: [source: 'type Subject = `b${Repeat<"x", 199>}`;'],
        expected: '`"b"` then `"x"` repeated 199 times',
      ],
      [
        args: [
          source: 'const f = (x: number) => x;\ntype Subject = Caught<Invoke<typeof f, [x: 1]>>["message"];',
        ],
        expected: "the `message` of the error `f` given x `1` throws",
      ],
    ]
  >;
}

const CONDITIONS: Record<
  ConditionName,
  (actual: string, expected: string, a: Assertion, scope: Scope) => string
> = {
  "=": (x, y, a) =>
    a.expected?.kind === "snapshot"
      ? `${x} matches its stored snapshot`
      : `${x} is ${y}`,
  "!=": (x, y) => `${x} is not ${y}`,
  is: (x, y) => `${x} is the very same value as ${y}`,
  isNot: (x, y) => `${x} is not the same value as ${y}`,
  satisfies: (x, y) => `${x} satisfies ${y}`,
  instanceOf: (x, y) => `${x} is an instance of ${y}`,
  truthy: (x) => `${x} is truthy`,
  falsy: (x) => `${x} is falsy`,
  defined: (x) => `${x} is defined`,
  undefined: (x) => `${x} is undefined`,
  throws: (x, _, a, scope) =>
    `${x} ${awaits(a.actual) ? "rejects" : "throws"}${thrownPhrase(a.expected, scope)}`,
  ">": (x, y) => `${x} is greater than ${y}`,
  ">=": (x, y) => `${x} is at least ${y}`,
  "<": (x, y) => `${x} is less than ${y}`,
  "<=": (x, y) => `${x} is at most ${y}`,
  "~=": (x, y, a) =>
    `${x} is within ${a.param ? printExpr(a.param) : "?"} of ${y}`,
  includes: (x, y) => `${x} includes ${y}`,
  excludes: (x, y) => `${x} does not include ${y}`,
  startsWith: (x, y) => `${x} starts with ${y}`,
  endsWith: (x, y) => `${x} ends with ${y}`,
  matches: (x, y, a, scope) =>
    a.shape === "string"
      ? `${x} matches the pattern ${y}`
      : a.expected?.kind === "object"
        ? `${x} has ${listed(a.expected.entries.map(([k, v]) => `${k} ${phrase(v, scope)}`))}`
        : `${x} matches, item by item, ${y}`,
  some: (x, y) => `some item of ${x} satisfies ${y}`,
  every: (x, y) => `every item of ${x} satisfies ${y}`,
  isEmpty: (x) => `${x} is empty`,
  isNotEmpty: (x) => `${x} is not empty`,
  hasKey: (x, y) => `${x} has the key ${y}`,
  lacksKey: (x, y) => `${x} has no key ${y}`,
  isNaN: (x) => `${x} is NaN`,
  isInteger: (x) => `${x} is a whole number`,
  isFinite: (x) => `${x} is finite`,
};

// `, with a message containing "no"`, ` a `RangeError``, ` a `Refusal` whose code is `64``
const THROWN_FIELDS: Record<
  Exclude<(typeof MATCHER_FIELDS)[number], "instanceOf">,
  string
> = {
  name: "name is",
  message: "message contains",
  matches: "message matches",
};

function thrownPhrase(expected: Expr | null, scope: Scope): string {
  // `Throws<X>` expects nothing, which lowers to `undefined`
  if (
    !expected ||
    (expected.kind === "literal" && expected.source === "undefined")
  )
    return "";
  if (expected.kind === "string")
    return `, saying ${code(printExpr(expected))}`;
  if (expected.kind !== "object")
    return ` ${phrase(expected, scope).replace(/^`/, "a `")}`;
  const cls = expected.entries.find(([k]) => k === "instanceOf");
  const fields = expected.entries
    .filter(([k]) => k !== "instanceOf")
    .map(
      ([k, v]) =>
        `${THROWN_FIELDS[k as keyof typeof THROWN_FIELDS] ?? `${k} is`} ${phrase(v, scope)}`,
    );
  return ` ${cls ? `a ${phrase(cls[1], scope)}` : "an error"}${fields.length ? ` whose ${listed(fields)}` : ""}`;
}

// some claims read better with the subject as the verb: "`Run` was never called", "`a.txt` exists"
function idiom(a: Assertion, scope: Scope): string | null {
  const { actual, condition, expected } = a;
  if (actual.kind === "calls") {
    const spy = phrase(actual.spy, scope);
    if (condition === "isEmpty") return `${spy} was never called`;
    if (condition === "isNotEmpty") return `${spy} was called`;
    if (condition === "=" && expected?.kind === "array") {
      const calls = expected.elements.map((call) =>
        call.kind === "array"
          ? call.elements.length
            ? listed(call.elements.map((x) => phrase(x, scope)))
            : "nothing"
          : phrase(call, scope),
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
    return `${phrase(actual.path, scope)} ${condition === "truthy" ? "exists" : "does not exist"}`;
  return null;
}

const assertionSentence = (a: Assertion, scope: Scope) =>
  idiom(a, scope) ??
  CONDITIONS[a.condition](
    phrase(a.actual, scope),
    a.expected ? phrase(a.expected, scope) : "",
    a,
    scope,
  );

// an effect is something done: "calling `f` with …", not the value it returns
function effectPhrase(e: Expr, scope: Scope): string {
  if (e.kind === "call")
    return (
      ownWords(e, scope) ??
      `calling ${withArgs(calleeName(e.callee), e, "with", scope)}`
    );
  if (e.kind === "method")
    return `calling ${withArgs(methodName(e, scope), e, "with", scope)}`;
  if (e.kind === "advanceTimers")
    return `moving fake time on ${printExpr(e.ms)} ms`;
  if (e.kind === "writeFile")
    return `writing ${phrase(e.text, scope)} to ${phrase(e.path, scope)}`;
  return phrase(e, scope);
}

// the same effect three times running is said once, with its count
const counted = (phrases: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < phrases.length; ) {
    let n = 1;
    while (phrases[i + n] === phrases[i]) n++;
    out.push(n > 1 ? `${phrases[i]} (${n} times)` : phrases[i]!);
    i += n;
  }
  return out;
};

const setupPhrase = (s: Setup, scope: Scope) =>
  s.kind === "fakeTimers"
    ? s.now
      ? `fake timers, the clock at ${phrase(s.now, scope)}`
      : "fake timers"
    : s.value
      ? `${code(s.name)} set to ${phrase(s.value, scope)}`
      : `${code(s.name)} unset`;

const mockPhrase = (m: ModuleMock) =>
  m.replacement
    ? `${code(m.path)} replaced by ${code(m.replacement.name)}`
    : `every export of ${code(m.path)} a recorded function`;

const capitalised = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

const bindingPhrase = (b: Binding, scope: Scope) =>
  b.params ? null : `${code(b.name)} is ${phrase(b.value, scope)}`;

/** A test, in words. */
export function describeTest(
  t: TestCase,
  lookup: Lookup = () => null,
): Description {
  const scope = { lookup };
  if (t.mode === "test.todo")
    return { sentence: "Not written yet.", where: [] };
  const conditions = [
    ...t.setup.map((s) => setupPhrase(s, scope)),
    ...t.mocks.map(mockPhrase),
  ];
  const effects = counted(
    t.body
      .filter(
        (s): s is Extract<Statement, { kind: "effect" }> => s.kind === "effect",
      )
      .map((s) => effectPhrase(s.expr, scope)),
  );
  const claims = t.body
    .filter(
      (s): s is Assertion & { line: number | null } => s.kind === "assert",
    )
    .map((a) => assertionSentence(a, scope));
  const lead = [
    conditions.length ? `with ${listed(conditions)}` : "",
    effects.length ? `after ${effects.join(", then ")}` : "",
  ].filter(Boolean);
  const body = listed(claims) || "nothing is checked";
  return {
    sentence: `${capitalised(lead.length ? `${lead.join(", ")}: ${body}` : body)}.`,
    where: t.bindings
      .map((b) => bindingPhrase(b, scope))
      .filter((w): w is string => w !== null),
  };
}

declare namespace describeTest {
  /** one claim on one call: the call, the condition, the value */
  export type Plain = Expect<
    Invoke<
      typeof harness.describeAlias,
      [
        'const add = (a: number, b: number) => a + b;\ndeclare namespace add { export type T = Expect<Invoke<typeof add, [a: 4, b: 5]>, "=", 9>; }',
        "T",
      ]
    >,
    "=",
    ["`add` given a `4` and b `5` is `9`."]
  >;

  type Debounce = `
    const debounce = (run: () => void, ms: number) => () => { setTimeout(run, ms); };
    declare namespace debounce {
      type Run = Spy<() => void>;
      type D = Invoke<typeof debounce, [run: Run, ms: 100]>;
      export type T = Given<[FakeTimers, Invoke<D>, Invoke<D>, AdvanceTimers<100>], Expect<Calls<Run>["length"], "=", 1>>;
    }
  `;

  /** setup, then each effect once with how often it ran, then the claim */
  export type Effects = Expect<
    Invoke<typeof harness.describeAlias, [Debounce, "T"]>,
    "=",
    [
      "With fake timers, after calling `D` (2 times), then moving fake time on 100 ms: how many times `Run` was called is `1`.",
    ]
  >;

  /** and what each alias the test names stands for */
  export type Where = Expect<
    Invoke<typeof harness.describeWhere, [Debounce, "T"]>,
    "=",
    [
      "`Run` is a recorded function",
      "`D` is `debounce` given run `Run` and ms `100`",
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
      Invoke<typeof harness.describeAlias, [Visits, "T"]>,
      "=",
      [
        "After calling `each` with xs `[1, 2]` and visit `Visit`: `Visit` was called with `1`, then `2`.",
      ]
    >,
    Expect<
      Invoke<typeof harness.describeAlias, [Visits, "None"]>,
      "=",
      [
        "After calling `each` with xs `[]` and visit `Visit`: `Visit` was never called.",
      ]
    >,
  ];

  type Refuses = `
    class Refusal extends Error { code = 64; }
    const parse = (text: string): number => { throw new Refusal(text); };
    declare namespace parse {
      export type T = Throws<Invoke<typeof parse, [text: "x"]>, { instanceOf: Refusal; code: 64 }>;
      export type M = Throws<Invoke<typeof parse, [text: "x"]>, "x">;
    }
  `;

  /** a refusal says what is thrown, and the fields it is known by */
  export type Thrown = [
    Expect<
      Invoke<typeof harness.describeAlias, [Refuses, "T"]>,
      "=",
      ['`parse` given text `"x"` throws a `Refusal` whose code is `64`.']
    >,
    Expect<
      Invoke<typeof harness.describeAlias, [Refuses, "M"]>,
      "=",
      ['`parse` given text `"x"` throws, saying `"x"`.']
    >,
  ];
}
