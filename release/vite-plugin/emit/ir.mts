import type { Internal } from "../../dsl.import.meta.vitest.ts";

export type Expr =
  // by value: the printer quotes it
  | { kind: "string"; value: string }
  // as printed: `1`, `-2`, `10n`, `true`, `null`, `undefined`
  | { kind: "literal"; source: string }
  | { kind: "array"; elements: Expr[] }
  | { kind: "object"; entries: [key: string, value: Expr][] }
  // `imported`: a value the test imports as a type (a harness function), re-imported to run
  | { kind: "name"; name: string; imported?: { from: string; name: string } }
  // awaited only when what it returns is thenable
  // `labels`: what each argument is, as the tuple names it or else the parameter
  | {
      kind: "call";
      callee: Expr;
      args: Expr[];
      awaited: boolean;
      labels?: (string | null)[];
    }
  // a constructor cannot be async, so it is never awaited
  | {
      kind: "construct";
      callee: Expr;
      args: Expr[];
      labels?: (string | null)[];
    }
  | {
      kind: "method";
      receiver: Expr;
      method: string;
      args: Expr[];
      awaited: boolean;
      labels?: (string | null)[];
    }
  | { kind: "index"; object: Expr; key: string | number }
  | { kind: "file"; path: Expr; format: Internal.FileFormat }
  // a `null` fallback means the variable must be set
  | { kind: "env"; name: string; fallback: Expr | null }
  // only meaningful as the expected value of `"="`
  | { kind: "snapshot"; name: Expr | null }
  // kept so the printed code reads as the type did
  | { kind: "paren"; inner: Expr }
  | { kind: "mocked"; inner: Expr }
  // the error `inner` throws or rejects with; `source` is how the test wrote it
  | { kind: "caught"; inner: Expr; source: string; awaited: boolean }
  // `vi.fn()`, or `vi.fn(impl)`
  | { kind: "spy"; impl: Expr | null }
  // what a spy was called with, a tuple per call
  | { kind: "calls"; spy: Expr }
  // a fresh directory holding these files, removed when the test ends
  | { kind: "tempDir"; files: Expr }
  | { kind: "exists"; path: Expr }
  | { kind: "listDir"; path: Expr }
  | { kind: "repeat"; text: Expr; count: Expr }
  // a template literal whose holes are values: `${head}${spans[0][0]}${spans[0][1]}…`
  | { kind: "template"; head: string; spans: [value: Expr, text: string][] }
  // effects with a meaning of their own, which run where they are written
  | { kind: "advanceTimers"; ms: Expr; awaited: true }
  | { kind: "writeFile"; path: Expr; text: Expr }
  // prints a call that fails at run time
  | { kind: "unsupported"; source: string };

// effects that apply before the test's code runs, and are undone when it ends
export type Setup = (
  | { kind: "fakeTimers"; now: Expr | null }
  // a null value unsets the variable
  | { kind: "stubEnv"; name: string; value: Expr | null }
) & { line: number };

export type ConditionName =
  | Internal.UniversalCondition
  | Internal.OrderingCondition
  | Internal.StringCondition
  | Internal.ArrayCondition
  | Internal.ObjectCondition
  | Internal.NumberCondition
  | Internal.ApproxCondition[0];

// what the checker knows of an actual that changes the matcher printed
export type Shape = "number" | "string" | "typedArray" | "other";

export type Assertion = {
  kind: "assert";
  actual: Expr;
  shape: Shape;
  condition: ConditionName;
  // the tolerance of `["~=", tolerance]`
  param: Expr | null;
  expected: Expr | null;
  // inside a tuple every expectation reports, so each is soft
  soft: boolean;
  display: { page: string; meta: Expr | null } | null;
};

// the `Given` half of a test
export type Effect = { kind: "effect"; expr: Expr };

export type Statement = (Assertion | Effect) & { line: number | null };

export type Param = {
  name: string;
  // from the type parameter's constraint
  type: string;
  // the type parameter's default
  fallback: Expr | null;
};

// a user alias the test reaches: a `const`, or an arrow when generic
export type Binding = {
  name: string;
  params: Param[] | null;
  // `Fixture<T, …>` keeps `T`
  annotation: string | null;
  value: Expr;
  line: number;
};

export type TestOptions = { timeout?: number; retry?: number };

// imported from another module: `vi.mock` runs before the test module's own code
export type Replacement = { from: string; name: string; factory: boolean };

export type ModuleMock = {
  path: string;
  replacement: Replacement | null;
  line: number;
};

export type Tag = { name: string; text: string };

export type TestCase = {
  name: string;
  path: string[];
  alias: string;
  row: number | null;
  line: number;
  // anchored to the alias, even for a table row
  doc: { text: string; line: number } | null;
  // a `/** … */` written just before one row of a table: what that row shows
  rowDoc: { text: string; line: number } | null;
  // `@control`, `@principle P4`, …: the alias's JSDoc tags, then the row's own
  tags: Tag[];
  mode: "test" | "test.skip" | "test.only" | "test.todo";
  // files the test needs, relative to it: when one is missing, the test is skipped
  requires: string[];
  options: TestOptions;
  bindings: Binding[];
  body: Statement[];
  // value re-imports of type-only bindings: specifier → `a as a$`…
  imports: Map<string, Set<string>>;
  mocks: ModuleMock[];
  setup: Setup[];
};

export const children = (e: Expr): Expr[] => {
  switch (e.kind) {
    case "array":
      return e.elements;
    case "object":
      return e.entries.map(([, value]) => value);
    case "call":
    case "construct":
      return [e.callee, ...e.args];
    case "method":
      return [e.receiver, ...e.args];
    case "index":
      return [e.object];
    case "file":
      return [e.path];
    case "env":
      return e.fallback ? [e.fallback] : [];
    case "snapshot":
      return e.name ? [e.name] : [];
    case "paren":
    case "mocked":
    case "caught":
      return [e.inner];
    case "spy":
      return e.impl ? [e.impl] : [];
    case "calls":
      return [e.spy];
    case "tempDir":
      return [e.files];
    case "exists":
    case "listDir":
      return [e.path];
    case "repeat":
      return [e.text, e.count];
    case "template":
      return e.spans.map(([value]) => value);
    case "advanceTimers":
      return [e.ms];
    case "writeFile":
      return [e.path, e.text];
    default:
      return [];
  }
};

export const some = (e: Expr, test: (e: Expr) => boolean): boolean =>
  test(e) || children(e).some((c) => some(c, test));

// every node that prints `await` says so where it is lowered
export const awaits = (e: Expr): boolean =>
  some(e, (n) => "awaited" in n && n.awaited);

/** What each DSL value is called where a test writes it, and what its printed form needs. */
export const DSL_KINDS: Partial<
  Record<Expr["kind"], { dsl: string; needs?: "vi" | "runtime" | "fs" }>
> = {
  file: { dsl: "FromFile", needs: "fs" },
  env: { dsl: "Env" },
  snapshot: { dsl: "Snapshot" },
  mocked: { dsl: "Mocked", needs: "vi" },
  caught: { dsl: "Caught", needs: "runtime" },
  spy: { dsl: "Spy", needs: "vi" },
  calls: { dsl: "Calls" },
  tempDir: { dsl: "TempDir", needs: "runtime" },
  exists: { dsl: "Exists", needs: "runtime" },
  listDir: { dsl: "ListDir", needs: "runtime" },
  repeat: { dsl: "Repeat" },
  template: { dsl: "template literal" },
  advanceTimers: { dsl: "AdvanceTimers", needs: "vi" },
  writeFile: { dsl: "WriteFile", needs: "runtime" },
};

const setupExprs = (s: Setup): Expr[] =>
  s.kind === "stubEnv" ? (s.value ? [s.value] : []) : s.now ? [s.now] : [];

/** Every expression a test evaluates: its bindings (and their defaults), its statements, its setup. */
export const exprsOfTest = (t: TestCase): Expr[] => [
  ...t.bindings.flatMap((b) => [
    ...(b.params ?? []).flatMap((p) => (p.fallback ? [p.fallback] : [])),
    b.value,
  ]),
  ...t.body.flatMap(exprsOf),
  ...t.setup.flatMap(setupExprs),
];

export const exprsOf = (s: Statement): Expr[] =>
  s.kind === "effect"
    ? [s.expr]
    : [
        s.actual,
        ...(s.expected ? [s.expected] : []),
        ...(s.param ? [s.param] : []),
        ...(s.display?.meta ? [s.display.meta] : []),
      ];
