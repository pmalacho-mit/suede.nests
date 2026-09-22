/**
 * authoring DSL
 *
 * Every export in this file is a *type*. Nothing here survives transpilation.
 * Tests are written as type aliases inside `declare namespace Tests { ... }`
 * blocks that live next to the code they exercise:
 *
 * ```ts
 * const add = (a: number, b: number) => a + b;
 *
 * declare namespace add {
 *   /** 4 + 5 is 9 *\/
 *   export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
 * }
 * ```
 *
 * The type checker gives you *shape* checking for free (you cannot expect a
 * string from a function that returns a number, or pass three arguments to a
 * two-argument function). The namespace-tests plugin then *evaluates* the
 * type-level program to check the actual *values*.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Conventions
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 1. Use `declare namespace`. It is ambient, so it is erased by tsc, esbuild,
 *    swc, and Node's `--experimental-strip-types`, and it passes
 *    `erasableSyntaxOnly`, `isolatedModules` and `verbatimModuleSyntax`.
 *
 * 2. `export` every test alias. Non-exported aliases trip `noUnusedLocals`.
 *    Because exported members merge across namespace blocks, scope tests to
 *    their subject with a dotted name: `declare namespace add { ... }`.
 *    Each test is emitted on its own, named for the dotted path it was
 *    written in (`add > Simple`).
 *
 * 3. JSDoc on a test alias becomes its human-readable description.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Evaluation model (what the runtime does with these types)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The runtime is a *printer*: it walks the syntax of each test alias (not its
 * resolved type, so it sees intent — `Invoke<...>` — rather than result —
 * `number`) and prints ordinary Vitest code, which Vitest then runs. Type
 * literals print as the equivalent value literals; DSL nodes print as calls
 * and `expect` matchers. See vite-plugin/emit/. The rules:
 *
 * - **Literals materialize to themselves.** `4`, `"olivia"`, `true`, `null`,
 *   `undefined`, `10n`, `-1`, tuples `[1, 2]` and object literals
 *   `{ name: "parker" }` become the corresponding JavaScript values.
 *   Non-literal types (`number`, `string[]`, unions, interfaces) are not values
 *   and are reported as authoring errors at their source location.
 *
 * - **`typeof x` materializes to the value `x`** — a function, class, const or
 *   `obj.method` (called with `obj` as `this`) from the module under test or
 *   anything it imports. Exported or not.
 *
 * - **A named type alias is a variable; an inline expression is not.**
 *   Within one test run every alias is evaluated at most once and its value is
 *   cached, so two references to `type Container = { name: "parker" }` are the
 *   *same object*. That is what lets you observe a mutation:
 *
 *   ```ts
 *   export type Rename = Given<
 *     Invoke<typeof setName, [Container, "olivia"]>,   // mutates the object…
 *     Expect<Container["name"], "=", "olivia">         // …that this reads.
 *   >;
 *   ```
 *   An inline `Invoke<...>` written twice runs twice.
 *
 * - **Each test is isolated.** The alias cache is discarded between tests, so
 *   `Container` above is a fresh object for every test that mentions it.
 *
 * - **Only referenced aliases are evaluated, in dependency order.** Each test
 *   becomes an ordinary async test function whose first statements are
 *   `const` bindings for the aliases it (transitively) references, followed by
 *   the effects and assertions in source order. Generic aliases
 *   (`type Parsed<S> = Invoke<typeof parse, [S]>`) become functions.
 *
 * - **Indexed access reads a property.** `Result["name"]`, `Bytes["length"]`,
 *   `Rows[0]["id"]` read the property from the materialized value.
 *
 * - **Promises are awaited.** `Invoke`, `Construct` and `Call` await the result
 *   if it is thenable.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Brands
// ═══════════════════════════════════════════════════════════════════════════

declare const NT: unique symbol;

/** Marker so the runtime (and hover text) can identify DSL nodes by name. */
interface Node<Kind extends string> {
  readonly [NT]: Kind;
}

type AnyFn = (...args: any[]) => any;

/**
 * `T & never` is eagerly `never`, and `X | never` is `X`, so `X | Phantom<T>` is
 * exactly `X` — but it "uses" `T`, which keeps parameters that exist purely
 * for the runtime (`Args`, `Path`, …) from tripping `noUnusedParameters`.
 */
type Phantom<T> = T & never;
type AnyCtor = abstract new (...args: any[]) => any;

/** The set of JavaScript values that can be written as a TypeScript literal type. */
export type Literal =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | AnyFn // only as `typeof fn` — an arbitrary function type cannot be materialized
  | readonly Literal[]
  | { readonly [key: string]: Literal };

// ═══════════════════════════════════════════════════════════════════════════
// Expressions — types that evaluate to a value
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Call a function with literal arguments. Evaluates to the (awaited) return type.
 *
 * ```ts
 * type Sum = Invoke<typeof add, [4, 5]>;               // number  ⇒ 9 at runtime
 * type Name = Invoke<typeof user.getName, []>;         // `this` is `user`
 * type Doubled = Invoke<typeof map, [[1, 2], typeof double]>; // functions are literals too
 * ```
 */
export type Invoke<F extends AnyFn, Args extends Parameters<F>> =
  | Awaited<ReturnType<F>>
  | Phantom<Args>;

/**
 * Instantiate a class with literal arguments. Evaluates to the instance type.
 * Bind it to an alias to keep a handle on the instance:
 *
 * ```ts
 * type Counter = Construct<typeof Counter, [10]>;
 * ```
 */
export type Construct<
  C extends AnyCtor,
  Args extends ConstructorParameters<C>,
> = InstanceType<C> | Phantom<Args>;

/**
 * Call a method on a materialized value (typically a `Construct` alias or a
 * `Fixture`). Evaluates to the (awaited) return type of the method.
 *
 * ```ts
 * type Counter = Construct<typeof Counter, [10]>;
 * export type Increments = Given<
 *   Call<Counter, "increment", []>,
 *   Expect<Counter["count"], "=", 11>
 * >;
 * ```
 */
export type Call<
  Receiver,
  Method extends MethodsOf<Receiver>,
  Args extends Receiver[Method] extends AnyFn
    ? Parameters<Receiver[Method]>
    : never,
> =
  | (Receiver[Method] extends AnyFn
      ? Awaited<ReturnType<Receiver[Method]>>
      : never)
  | Phantom<Args>;

type MethodsOf<T> = {
  [K in keyof T]-?: T[K] extends AnyFn ? K : never;
}[keyof T] &
  string;

/**
 * A typed fixture: declares the *type* the rest of the test sees and the
 * literal *initial value* the runtime materializes. Solves the problem that a
 * literal `{ name: "parker" }` has type `{ name: "parker" }`, which would
 * reject an expectation of `"olivia"` after a mutation.
 *
 * ```ts
 * type Container = Fixture<{ name: string }, { name: "parker" }>;
 * ```
 *
 * Prefer this over `Widen` when you know the intended shape.
 */
export type Fixture<T, Initial extends T & Literal> = T | Phantom<Initial>;


/**
 * Widen literal types to their primitive base (`"parker"` → `string`,
 * `[1, 2]` → `number[]`) while the runtime still materializes the literal.
 * Handy when a fixture's shape is obvious and you don't want to spell it out.
 */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T extends symbol
          ? symbol
          : T extends readonly (infer U)[]
            ? Widen<U>[]
            : T extends object
              ? { -readonly [K in keyof T]: Widen<T[K]> }
              : T;

/** How a file's contents are decoded by `FromFile`. */
export type FileFormat = "text" | "bytes" | "json";

/**
 * Load a file relative to the test file at runtime.
 *
 * ```ts
 * type Png = FromFile<"./fixtures/logo.png", "bytes">;      // Uint8Array
 * type Csv = FromFile<"./fixtures/rows.csv">;                // string
 * type Cfg = FromFile<"./fixtures/config.json", "json", AppConfig>;
 * ```
 */
export type FromFile<
  Path extends string,
  Format extends FileFormat = "text",
  Json = unknown,
> =
  | (Format extends "text"
      ? string
      : Format extends "bytes"
        ? Uint8Array
        : Json)
  | Phantom<Path>;

/**
 * Read an environment variable at runtime. Evaluates to `string`, or to
 * `Default` when the variable is unset. Tests that read an unset variable
 * with no default fail with a clear message.
 */
export type Env<
  Name extends string,
  Default extends string | undefined = undefined,
> = string | Default | Phantom<Name>;

// ═══════════════════════════════════════════════════════════════════════════
// Expectations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A stored expected value. On first run the runtime writes the actual value to
 * `__snapshots__/<file>.<TestName>[.<Name>].snap` next to the test file; on
 * later runs it compares against that file. Updating snapshots is a runner
 * command, not a code change.
 *
 * ```ts
 * export type Renders = Expect<Invoke<typeof render, [Tree]>, "=", Snapshot>;
 * export type Both = [
 *   Expect<Invoke<typeof render, [Tree]>, "=", Snapshot<"html">>,
 *   Expect<Invoke<typeof toText, [Tree]>, "=", Snapshot<"text">>,
 * ];
 * ```
 */
export interface Snapshot<Name extends string = ""> extends Node<"snapshot"> {
  readonly name: Name;
}

/** Placeholder for conditions that take no expected value (`"truthy"`, `"throws"` …). */
export interface Nothing extends Node<"nothing"> {}

/** Conditions that apply to any value. */
export type UniversalCondition =
  | "=" // deep structural equality (Object.is for primitives, element-wise for arrays/typed arrays, key-wise for objects)
  | "!=" // negation of "="
  | "is" // reference identity (Object.is), useful with aliases: Expect<Call<B, "self", []>, "is", B>
  | "isNot"
  | "satisfies" // Expected is `typeof predicate`; passes when predicate(actual) is truthy
  | "instanceOf" // Expected is `typeof SomeClass`
  | "truthy"
  | "falsy"
  | "defined" // !== undefined
  | "undefined"
  | "throws"; // the expression threw / rejected. Expected is optional: `typeof ErrorClass`, a message substring, or a matcher object

/** Ordering conditions; valid for numbers, bigints, strings and Dates. */
export type OrderingCondition = ">" | ">=" | "<" | "<=";

/** Approximate equality with an absolute tolerance: `["~=", 1e-9]`. */
export type ApproxCondition = readonly ["~=", number];

/** Conditions valid on strings. */
export type StringCondition =
  | "includes"
  | "excludes"
  | "startsWith"
  | "endsWith"
  | "matches" // Expected is a regular-expression source string, e.g. "^[a-z]+$" or "/^[a-z]+$/i"
  | "isEmpty"
  | "isNotEmpty";

/** Conditions valid on arrays and typed arrays. */
export type ArrayCondition =
  | "includes" // element (deep equality)
  | "excludes"
  | "matches" // Expected is a deep-partial of each element, in order, same length
  | "some" // Expected is `typeof predicate`
  | "every"
  | "isEmpty"
  | "isNotEmpty";

/** Conditions valid on plain objects. */
export type ObjectCondition =
  | "matches" // Expected is a deep-partial of Actual: only listed keys are compared
  | "hasKey"
  | "lacksKey";

/** Conditions valid on numbers. */
export type NumberCondition = "isNaN" | "isInteger" | "isFinite";

/** All conditions applicable to a value of type `T`. */
export type ConditionsFor<T> =
  | UniversalCondition
  | (T extends number
      ? OrderingCondition | ApproxCondition | NumberCondition
      : never)
  | (T extends bigint | Date ? OrderingCondition : never)
  | (T extends string ? OrderingCondition | StringCondition : never)
  | (T extends readonly unknown[] | ArrayBufferView ? ArrayCondition : never)
  // A Set is a collection, not a bag of properties: `toContain` and
  // `toHaveLength` both understand one.
  | (T extends ReadonlySet<unknown> ? ArrayCondition : never)
  // A Map understands `toHaveLength`, but not `toContain` — ask about a key
  // with `Call<M, "has", [k]>`.
  | (T extends ReadonlyMap<unknown, unknown> ? "isEmpty" | "isNotEmpty" : never)
  | (T extends object
      ? T extends readonly unknown[] | AnyFn
        ? never
        : ObjectCondition
      : never);

/** Conditions that take no expected value. */
export type NullaryCondition =
  | "truthy"
  | "falsy"
  | "defined"
  | "undefined"
  | "isEmpty"
  | "isNotEmpty"
  | "isNaN"
  | "isInteger"
  | "isFinite";

/**
 * Every key optional, at any depth — but a list stays a list. Mapping over a
 * tuple keeps it a tuple, so an expected list written for a tuple actual is
 * checked position by position, which is how `toMatchObject` compares them:
 * element-wise, same length, in order.
 *
 * A plain array is written as `readonly DeepPartial<Element>[]` rather than
 * mapped over. The compiler defers an array of an alias but expands a mapped
 * array eagerly, and on a recursive type (a JSON value, say) that expansion
 * never bottoms out ("type instantiation is excessively deep"). The tuple test
 * is type-fest's: an array of the element type is assignable to a plain array
 * and never to a tuple, whatever its optional or rest elements. `readonly`
 * because this is only ever the type of an *expected* value, and a readonly
 * target accepts a readonly or a mutable literal alike.
 *
 * A function is left as it is: a mapped type would keep its properties and
 * drop its call signature, so `{ onClick: () => void }` would accept anything.
 */
export type DeepPartial<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends readonly (infer Element)[]
    ? Element[] extends T
      ? readonly DeepPartial<Element>[]
      : { [Index in keyof T]: DeepPartial<T[Index]> }
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

type ElementOf<T> = T extends readonly (infer U)[]
  ? U
  : T extends ReadonlySet<infer U>
    ? U
    : T extends string
      ? string
      : T extends { [n: number]: infer U }
        ? U
        : never;

/**
 * Typed arrays may be compared against plain tuples/arrays of their element type,
 * so `Expect<Uint32Array, "=", [1, 2, 3]>` type-checks.
 */
type Equatable<T> =
  | T
  | (T extends { [n: number]: infer E; readonly length: number }
      ? readonly E[]
      : never);

/**
 * A class written as a value (`typeof RangeError`) or, for error classes, as a
 * type (`RangeError`). The runtime resolves either spelling to the constructor.
 * For `"instanceOf"` on non-error classes the actual's own instance type is
 * also accepted: `Expect<Repo, "instanceOf", UserRepository>`.
 */
export type ClassRef = AnyCtor | Error;

/** Shape the expected value must have for a given (Actual, Condition) pair. */
export type ExpectedFor<Actual, Condition> = Condition extends NullaryCondition
  ? Nothing
  : Condition extends "=" | "!=" | "is" | "isNot"
    ? Equatable<Actual>
    : Condition extends OrderingCondition
      ? Actual
      : Condition extends ApproxCondition
        ? number
        : Condition extends "includes" | "excludes"
          ? ElementOf<Actual>
          : Condition extends "startsWith" | "endsWith"
            ? string
            : Condition extends "matches"
              ? Actual extends string
                ? string
                : DeepPartial<Actual>
              : Condition extends "some" | "every"
                ? (element: ElementOf<Actual>, index: number) => boolean
                : Condition extends "satisfies"
                  ? (actual: Actual) => boolean
                  : Condition extends "instanceOf"
                    ? ClassRef | (Actual extends object ? Actual : never)
                    : Condition extends "hasKey" | "lacksKey"
                      ? keyof Actual & string
                      : Condition extends "throws"
                        ? Nothing | ClassRef | string | ThrowsMatcher
                        : never;

/** Object form of a `"throws"` expectation. All fields optional; all listed fields must match. */
export interface ThrowsMatcher {
  readonly instanceOf?: ClassRef;
  readonly name?: string;
  readonly message?: string; // substring
  readonly matches?: string; // regex source
}

/** The page is loaded relative to the test file. */
export type DisplayPage = `${string}.html`;

export type Config = Partial<{
  /** Custom HTML page used to render this result in the IDE's webview. */
  display: DisplayPage;
  /** Where the module under test is evaluated. Default: "node". */
  environment: "node" | "browser";
  /** Per-test timeout in milliseconds. Default: 5000. */
  timeout: number;
  /** Working directory for relative paths and `FromFile`. Default: the test file's directory. */
  cwd: string;
  /** Re-run a failing test this many times before reporting failure. Default: 0. */
  retries: number;
  /** Extra literal data forwarded to the display page as `meta` (e.g. an image's width). */
  displayMeta: { readonly [key: string]: Literal };
}>;

/**
 * The core assertion.
 *
 * ```ts
 * Expect<Invoke<typeof add, [4, 5]>, "=", 9>
 * Expect<Invoke<typeof greet, ["Ada"]>, "startsWith", "Hello">
 * Expect<Invoke<typeof sqrt, [2]>, ["~=", 1e-12], 1.4142135623730951>
 * Expect<Invoke<typeof parse, ["{"]>, "throws", SyntaxError>
 * Expect<Invoke<typeof list, []>, "isEmpty">
 * Expect<Pixels, "=", ExpectedPixels, "./display-image.html">
 * ```
 *
 * `Expected` is constrained by `Actual` and `Condition` together, so mismatched
 * shapes are compile errors — the IDE tells you before the runtime does.
 */
export type Expect<
  Actual,
  Condition extends ConditionsFor<Actual>,
  Expected extends ExpectedFor<Actual, Condition> | Snapshot<any> | Nothing =
    Nothing,
  DisplayOrConfig extends undefined | DisplayPage | Config = undefined,
> = Expected extends Nothing
  ? Condition extends NullaryCondition | "throws"
    ? Assertion<Actual, Condition, Expected, DisplayOrConfig>
    : MissingExpected<Condition>
  : Assertion<Actual, Condition, Expected, DisplayOrConfig>;

/**
 * What `Expect<X, "=">` evaluates to: the expected value was omitted for a
 * condition that needs one. This is deliberately *not* a `Test`, so it is a
 * compile error inside `Given`, `Skip`, `Only`, `Configure` or a `Table`, is
 * obvious in hover text, and is reported by the runner as an authoring error.
 * (TypeScript cannot reject an omitted type argument at the use site, so the
 * mistake is surfaced in the result type instead.)
 */
export interface MissingExpected<Condition> extends Node<"error"> {
  readonly error: "an expected value is required for this condition";
  readonly condition: Condition;
}

/** Shorthand for `Expect<Expr, "throws", Matcher>`. */
export type Throws<
  Expr,
  Matcher extends ExpectedFor<Expr, "throws"> = Nothing,
> = Assertion<Expr, "throws", Matcher, undefined>;

/** The evaluated result of `Expect`. You'll see this in hover text. */
export interface Assertion<
  Actual,
  Condition,
  Expected,
  DisplayOrConfig,
> extends Node<"assertion"> {
  readonly actual: Actual;
  readonly condition: Condition;
  readonly expected: Expected;
  readonly config: DisplayOrConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// Composition
// ═══════════════════════════════════════════════════════════════════════════

/** Anything that can be the right-hand side of an exported test alias. */
export type Test =
  | Node<"assertion">
  | Node<"sequence">
  | Node<"table">
  | Node<"modifier">
  | readonly Test[];

/**
 * Run `Effects` (an expression, or a tuple of expressions, evaluated in order
 * purely for their side effects), then evaluate `Then`.
 *
 * ```ts
 * export type Rename = Given<
 *   Invoke<typeof setName, [Container, "olivia"]>,
 *   Expect<Container["name"], "=", "olivia">
 * >;
 *
 * export type Lifecycle = Given<
 *   [Call<Store, "open", []>, Call<Store, "put", ["k", 1]>],
 *   [Expect<Call<Store, "get", ["k"]>, "=", 1>, Expect<Store["size"], "=", 1>]
 * >;
 * ```
 */
export type Given<Effects, Then extends Test> = Sequence<Effects, Then>;

export interface Sequence<Effects, Then> extends Node<"sequence"> {
  readonly effects: Effects;
  readonly then: Then;
}

/** `Given` + `Expect` in one call (the original scaffold's shape). */
export type ExpectGiven<
  Effects,
  Actual,
  Condition extends ConditionsFor<Actual>,
  Expected extends ExpectedFor<Actual, Condition> | Snapshot<any> | Nothing =
    Nothing,
  DisplayOrConfig extends undefined | DisplayPage | Config = undefined,
> = Sequence<Effects, Expect<Actual, Condition, Expected, DisplayOrConfig>>;

/**
 * A row of a `Table`: `[args, expected]` (implied `"="`) or `[args, condition, expected]`.
 */
export type Row<F extends AnyFn> =
  | readonly [
      args: Parameters<F>,
      expected: Awaited<ReturnType<F>> | Snapshot<any>,
    ]
  | readonly [
      args: Parameters<F>,
      condition: ConditionsFor<Awaited<ReturnType<F>>>,
      expected:
        | ExpectedFor<
            Awaited<ReturnType<F>>,
            ConditionsFor<Awaited<ReturnType<F>>>
          >
        | Snapshot<any>,
    ];

/**
 * Parameterised tests: call `F` once per row and check the result.
 * Each row is reported as its own case (`Tests > add > Table[2]`).
 *
 * **STRONGLY RECOMMENDED** to use named tuples for clarity.
 *
 * ```ts
 * export type Cases = Table<typeof add, [
 *   [args: [1, 2], expected: 3],
 *   [args: [a: -1, b: 1], expected: 0], // even more names!
 *   [args: [0.1, 0.2], condition: ["~=", 1e-9], expected: 0.3],
 * ]>;
 * ```
 */
export type Table<F extends AnyFn, Rows extends readonly Row<F>[]> = TableNode<
  F,
  Rows
>;

export interface TableNode<F, Rows> extends Node<"table"> {
  readonly fn: F;
  readonly rows: Rows;
}

/** Skip a test. It is discovered and shown as skipped, never run. */
export type Skip<T extends Test, Reason extends string = ""> = Modifier<
  "skip",
  T,
  Reason
>;

/** Run only tests marked `Only` (when any exist in the workspace/file). */
export type Only<T extends Test> = Modifier<"only", T, "">;

/** A planned test with no body yet. Shown as "todo". */
export type Todo<Reason extends string = ""> = Modifier<"todo", never, Reason>;

/** Apply a `Config` to a whole test (or tuple of tests). */
export type Configure<C extends Config, T extends Test> = Modifier<
  "configure",
  T,
  C
>;

export interface Modifier<
  Kind extends string,
  T,
  Payload,
> extends Node<"modifier"> {
  readonly kind: Kind;
  readonly test: T;
  readonly payload: Payload;
}
