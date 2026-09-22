// The intermediate representation: what a test *means*, with the TypeScript
// syntax gone. `model.mts` builds it from type nodes (that is the only stage
// that needs the checker); `print.mts` turns it into Vitest code (that stage
// never sees a `ts.Node`). Anything that wants to know something about a test
// — which helpers it needs, whether an expected value must be hoisted, what a
// row of a table calls — reads this, not strings.
import type {
  ApproxCondition,
  ArrayCondition,
  FileFormat,
  NumberCondition,
  ObjectCondition,
  OrderingCondition,
  StringCondition,
  UniversalCondition,
} from "../../dsl.import.meta.vitest.ts";

/** A JavaScript expression a type node stands for. */
export type Expr =
  /** A string literal, by value: the printer quotes it. */
  | { kind: "string"; value: string }
  /** Any other literal, as it will be printed: `1`, `-2`, `10n`, `true`, `null`, `undefined`. */
  | { kind: "literal"; source: string }
  | { kind: "array"; elements: Expr[] }
  | { kind: "object"; entries: [key: string, value: Expr][] }
  /** A value in scope, as written: `add`, `user.getName`, `dsl$.x`. */
  | { kind: "name"; name: string }
  /**
   * `Invoke`, or a generic alias applied to arguments: `f(…)`. `awaited` when
   * what it returns is thenable — only then is there a promise to unwrap.
   */
  | { kind: "call"; callee: Expr; args: Expr[]; awaited: boolean }
  /** `Construct`: `new C(…)`. A constructor cannot be async, so never awaited. */
  | { kind: "construct"; callee: Expr; args: Expr[] }
  /** `Call`: `receiver.method(…)`, awaited on the same terms as a call. */
  | { kind: "method"; receiver: Expr; method: string; args: Expr[]; awaited: boolean }
  /** `X["key"]`, `X[0]`. */
  | { kind: "index"; object: Expr; key: string | number }
  /** `FromFile`. */
  | { kind: "file"; path: Expr; format: FileFormat }
  /** `Env`: a fallback of `null` means the variable must be set. */
  | { kind: "env"; name: string; fallback: Expr | null }
  /** `Snapshot<Name>`; only meaningful as the expected value of `"="`. */
  | { kind: "snapshot"; name: Expr | null }
  /** A parenthesised type, kept so the printed code reads as the type did. */
  | { kind: "paren"; inner: Expr }
  /** Something no value can stand for: prints a call that fails at run time. */
  | { kind: "unsupported"; source: string };

/** Every condition the DSL can express. The printer must cover all of them. */
export type ConditionName =
  | UniversalCondition
  | OrderingCondition
  | StringCondition
  | ArrayCondition
  | ObjectCondition
  | NumberCondition
  | ApproxCondition[0];

/** What the type checker knows about an actual that changes the matcher printed. */
export type Shape = "number" | "string" | "typedArray" | "other";

export type Assertion = {
  kind: "assert";
  actual: Expr;
  shape: Shape;
  condition: ConditionName;
  /** The parameter of `["~=", tolerance]`. */
  param: Expr | null;
  expected: Expr | null;
  /** Inside a tuple every expectation reports, so they are soft. */
  soft: boolean;
  /** Expect's 4th argument: a display page for the IDE, and its meta. */
  display: { page: string; meta: Expr | null } | null;
};

/** An expression evaluated for its effect alone: the `Given` half of a test. */
export type Effect = { kind: "effect"; expr: Expr };

/** One statement of a test body, anchored to the 0-based source line it came from. */
export type Statement = (Assertion | Effect) & { line: number | null };

/** One parameter of a generic alias: a type parameter, as a value. */
export type Param = {
  name: string;
  /** The annotation, from the type parameter's constraint: `string`, `unknown`. */
  type: string;
  /** What a reference that leaves it out gets — the type parameter's default, or null. */
  fallback: Expr | null;
};

/** A user alias the test references, hoisted to a `const` — or, when generic, an async arrow. */
export type Binding = {
  name: string;
  /** Its parameters, or null for a plain const. */
  params: Param[] | null;
  /** A declared type for the const (`Fixture<T, …>` keeps `T`), or null. */
  annotation: string | null;
  value: Expr;
  line: number;
};

/** Vitest options a `Configure<…>` sets on the test. */
export type TestOptions = { timeout?: number; retry?: number };

export type TestCase = {
  /** What Vitest reports: the namespace path and the alias, e.g. `add > Simple`. */
  name: string;
  /** Namespace segments, as written (`declare namespace parser.errors` → `["parser", "errors"]`). */
  path: string[];
  /** The `export type` alias this test came from. */
  alias: string;
  /** For a `Table<…>` row, its 0-based index; null otherwise. */
  row: number | null;
  /** 0-based line of the alias (or of the row) in the source file. */
  line: number;
  /** The JSDoc on the alias, anchored to the alias even for a table row. */
  doc: { text: string; line: number } | null;
  /** The Vitest function to call. */
  mode: "test" | "test.skip" | "test.only" | "test.todo";
  options: TestOptions;
  bindings: Binding[];
  body: Statement[];
  /** Value re-imports of type-only bindings this test reaches: specifier → `a as a$`… */
  imports: Map<string, Set<string>>;
};

/** The sub-expressions of an expression, for a walk. */
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
      return [e.inner];
    default:
      return [];
  }
};

/** Does any node of the expression satisfy `test`? */
export const some = (e: Expr, test: (e: Expr) => boolean): boolean =>
  test(e) || children(e).some((c) => some(c, test));

/**
 * Does evaluating this expression await anything? What holds it — a test, an
 * alias turned function, a thunk that must throw — has to be `async` exactly
 * when this is true, and not a line sooner.
 */
export const awaits = (e: Expr): boolean =>
  some(e, (n) => (n.kind === "call" || n.kind === "method") && n.awaited);

/** The expressions a statement evaluates. */
export const exprsOf = (s: Statement): Expr[] =>
  s.kind === "effect"
    ? [s.expr]
    : [
        s.actual,
        ...(s.expected ? [s.expected] : []),
        ...(s.param ? [s.param] : []),
        ...(s.display?.meta ? [s.display.meta] : []),
      ];
