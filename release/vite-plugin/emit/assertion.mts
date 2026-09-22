// One DSL condition → one `expect` chain, and one Test node → its statements.
//
// `matcherTable` is the heart of it, and is deliberately free of TypeScript AST
// types: by the time it runs, actual and expected are printed strings.
import ts from "typescript";

import {
  asEmitContext,
  ensureEmitContext,
  isInputOrContext,
} from "./context.mts";
import { arity, expr, literalText } from "./expression.mts";

import type { EmitInputOrContext, Line } from "./context.mts";
import type { Assertion } from "vitest";
import type {
  ApproxCondition,
  ArrayCondition,
  NumberCondition,
  ObjectCondition,
  OrderingCondition,
  StringCondition,
  UniversalCondition,
} from "../../dsl.import.meta.vitest.ts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";
import type { printStatements } from "../../_internal/harness.mts";
/** Sentinel condition used by `Throws<…>`, which has no condition node. */
export const THROWS = "throws" as const;

/** An already-printed actual expression with its type (table rows). */
export type PrintedActual = { code: string; type: ts.Type };

/** A parsed condition: the operator and, for `["~=", tol]`, the printed parameter. */
export type Condition = { op: string; param?: string };

/** Display-page configuration extracted from Expect's 4th argument. */
export type Display = { display: string; meta: string | null };

/** A matcher on Vitest's `expect(…)`: anything callable, so `not`/`resolves` aside. */
type Callable = (...args: never[]) => unknown;

/** The name of a real Vitest matcher — a typo cannot get past this. */
export type MatcherName = {
  [K in keyof Assertion & string]-?: Assertion[K] extends Callable ? K : never;
}[keyof Assertion & string];

/** Homomorphic, so a tuple of parameters stays a tuple. */
type Printed<P extends readonly unknown[]> = { [I in keyof P]: string };

/** One printed argument per parameter the matcher declares. */
export type PrintedArgs<K extends MatcherName> = Printed<
  Parameters<Extract<Assertion[K], Callable>>
>;

/** Every condition the DSL can express — the printer must cover all of them. */
export type ConditionName =
  | UniversalCondition
  | OrderingCondition
  | StringCondition
  | ArrayCondition
  | ObjectCondition
  | NumberCondition
  | ApproxCondition[0];

/** An `expect` chain whose matcher and arity have already been checked. */
export type MatcherChain = {
  matcher: string;
  args: string[];
  /** `.not` before the matcher. */
  negated?: boolean;
  /** `.rejects` before the matcher: the actual is a thunk that must reject. */
  rejects?: boolean;
};

/**
 * Build one `expect` chain. `matcher` must name a Vitest matcher and `args`
 * must print one argument per parameter it takes, so the printer cannot emit
 * `.toEqul(…)` or forget an expected value.
 */
export const chain = <K extends MatcherName>(
  matcher: K,
  args: PrintedArgs<K>,
  modifiers: Pick<MatcherChain, "negated" | "rejects"> = {},
): MatcherChain => ({ matcher, args: args as string[], ...modifiers });

/** What a condition compiles to. */
export type Expectation = {
  /**
   * The expression handed to `expect(…)`, when the condition asserts on
   * something derived rather than on the actual itself (`"~="`, and the
   * ordering conditions on non-numbers).
   */
  actual?: string;
  chain: MatcherChain;
};

/**
 * What a condition needs in order to print, once actual and expected are
 * printed strings. Only `actual` is required: the rest describe an assertion
 * that is anything other than a plain `expect(actual).matcher(expected)`.
 */
export type MatcherParts = {
  /** The printed actual expression. */
  actual: string;
  /** The printed expected value (or the name it was hoisted to). */
  expected?: string | undefined;
  /** The printed parameter of a parameterised condition, e.g. the tolerance of `["~=", tol]`. */
  param?: string | undefined;
  /** `expect` or `expect.soft`. Defaults to `expect`. */
  expectFn?: string | undefined;
  /** Actual is number-like or bigint-like, so the ordering matchers apply. */
  numeric?: boolean | undefined;
  /** Actual is string-like, so `matches` means `toMatch` rather than `toMatchObject`. */
  stringLike?: boolean | undefined;
  isSnapshot?: boolean | undefined;
  snapshotName?: string | undefined;
  /** The chain a `throws` expectation applies after `.rejects`. */
  throwsChain?: MatcherChain | undefined;
  /** This expectation is routed through `ntCheck`, which awaits for us. */
  hasDisplay?: boolean | undefined;
  /** Wraps a chain into a statement. Defaults to `expect(actual)<chain>;`. */
  line?: ((chain: string) => string) | undefined;
};

/** Every default filled in, so the table and the renderer read one shape. */
const resolve = (parts: MatcherParts) => {
  const expectFn = parts.expectFn ?? "expect";
  return {
    actual: parts.actual,
    expected: parts.expected ?? "undefined",
    param: parts.param,
    expectFn,
    numeric: parts.numeric ?? false,
    stringLike: parts.stringLike ?? false,
    isSnapshot: parts.isSnapshot ?? false,
    snapshotName: parts.snapshotName ?? "",
    throwsChain: parts.throwsChain ?? chain("toThrow", []),
    hasDisplay: parts.hasDisplay ?? false,
    line: parts.line ?? ((c: string) => `${expectFn}(${parts.actual})${c};`),
  };
};

/** Condition name → the expectation it compiles to. Exhaustive over the DSL. */
export function matcherTable(
  parts: MatcherParts,
): Record<ConditionName, () => Expectation> {
  const {
    actual: A,
    expected: e,
    param,
    numeric,
    stringLike,
    isSnapshot,
    snapshotName,
    throwsChain,
  } = resolve(parts);

  /** An ordering condition: a matcher on numbers, a plain comparison otherwise. */
  const ordering = (
    matcher:
      | "toBeGreaterThan"
      | "toBeGreaterThanOrEqual"
      | "toBeLessThan"
      | "toBeLessThanOrEqual",
    operator: string,
  ): Expectation =>
    numeric
      ? { chain: chain(matcher, [e]) }
      : { actual: `${A} ${operator} ${e}`, chain: chain("toBe", ["true"]) };

  return {
    "=": () => ({
      chain: isSnapshot
        ? chain("toMatchSnapshot", snapshotName ? [snapshotName] : [])
        : chain("toEqual", [e]),
    }),
    "!=": () => ({ chain: chain("toEqual", [e], { negated: true }) }),
    is: () => ({ chain: chain("toBe", [e]) }),
    isNot: () => ({ chain: chain("toBe", [e], { negated: true }) }),
    satisfies: () => ({ chain: chain("toSatisfy", [e]) }),
    instanceOf: () => ({ chain: chain("toBeInstanceOf", [e]) }),
    truthy: () => ({ chain: chain("toBeTruthy", []) }),
    falsy: () => ({ chain: chain("toBeFalsy", []) }),
    defined: () => ({ chain: chain("toBeDefined", []) }),
    undefined: () => ({ chain: chain("toBeUndefined", []) }),
    throws: () => ({ chain: { ...throwsChain, rejects: true } }),
    ">": () => ordering("toBeGreaterThan", ">"),
    ">=": () => ordering("toBeGreaterThanOrEqual", ">="),
    "<": () => ordering("toBeLessThan", "<"),
    "<=": () => ordering("toBeLessThanOrEqual", "<="),
    "~=": () => ({
      actual: `Math.abs(${A} - ${e})`,
      chain: chain("toBeLessThanOrEqual", [`${param}`]),
    }),
    includes: () => ({ chain: chain("toContain", [e]) }),
    excludes: () => ({ chain: chain("toContain", [e], { negated: true }) }),
    startsWith: () => ({
      chain: chain("toSatisfy", [`(s: string) => s.startsWith(${e})`]),
    }),
    endsWith: () => ({
      chain: chain("toSatisfy", [`(s: string) => s.endsWith(${e})`]),
    }),
    matches: () => ({
      chain: stringLike
        ? chain("toMatch", [regex(e)])
        : chain("toMatchObject", [e]),
    }),
    // toSatisfy<E> does not infer E from the actual, hence the annotation
    some: () => ({
      chain: chain("toSatisfy", [
        `(xs: ArrayLike<any>) => Array.from(xs).some(${e})`,
      ]),
    }),
    every: () => ({
      chain: chain("toSatisfy", [
        `(xs: ArrayLike<any>) => Array.from(xs).every(${e})`,
      ]),
    }),
    isEmpty: () => ({ chain: chain("toHaveLength", ["0"]) }),
    isNotEmpty: () => ({
      chain: chain("toHaveLength", ["0"], { negated: true }),
    }),
    hasKey: () => ({ chain: chain("toHaveProperty", [e]) }),
    lacksKey: () => ({
      chain: chain("toHaveProperty", [e], { negated: true }),
    }),
    isNaN: () => ({ chain: chain("toBeNaN", []) }),
    isInteger: () => ({ chain: chain("toSatisfy", ["Number.isInteger"]) }),
    isFinite: () => ({ chain: chain("toSatisfy", ["Number.isFinite"]) }),
  };
}

/** The expectation a condition compiles to, or null when the DSL has no such condition. */
export function expectationFor(
  parts: MatcherParts,
  op: string,
): Expectation | null {
  const table = matcherTable(parts);
  return Object.hasOwn(table, op) ? table[op as ConditionName]() : null;
}

/** `.rejects`, `.not`, the matcher and its arguments, as source text. */
export const renderChain = (c: MatcherChain): string =>
  `${c.rejects ? ".rejects" : ""}${c.negated ? ".not" : ""}.${c.matcher}(${c.args.join(", ")})`;

/** One expectation as a statement. */
export function renderExpectation(
  parts: MatcherParts,
  { actual, chain: c }: Expectation,
): string {
  const { expectFn, line, hasDisplay } = resolve(parts);
  const text = renderChain(c);
  // a derived actual is asserted on directly — ntCheck only ever sees the real one
  if (actual !== undefined) return `${expectFn}(${actual})${text};`;
  const statement = line(text);
  return c.rejects && !hasDisplay ? `await ${statement}` : statement;
}

/**
 * The statement a condition prints, or `""` when the DSL has no such condition.
 * The whole of one assertion, given operands that are already printed.
 */
export function renderCondition(op: string, parts: MatcherParts): string {
  const expectation = expectationFor(parts, op);
  return expectation ? renderExpectation(parts, expectation) : "";
}

/** A printed string literal as a regex: `"/x/i"` → `/x/i`, otherwise `new RegExp("x")`. */
declare namespace Tests.renderCondition {
  type Operands = { actual: "a"; expected: "b" };

  /** every condition, as the statement it prints */
  export type Conditions = Table<
    typeof renderCondition,
    [
      [args: ["=", Operands], expected: "expect(a).toEqual(b);"],
      [args: ["!=", Operands], expected: "expect(a).not.toEqual(b);"],
      [args: ["is", Operands], expected: "expect(a).toBe(b);"],
      [args: ["includes", Operands], expected: "expect(a).toContain(b);"],
      [
        args: ["isEmpty", { actual: "a" }],
        expected: "expect(a).toHaveLength(0);",
      ],
      [
        args: ["isInteger", { actual: "a" }],
        expected: "expect(a).toSatisfy(Number.isInteger);",
      ],
      [
        args: [op: ">", parts: { actual: "a"; expected: "b"; numeric: true }],
        expected: "expect(a).toBeGreaterThan(b);",
      ],
      [
        args: ["~=", { actual: "a"; expected: "b"; param: "0.5" }],
        expected: "expect(Math.abs(a - b)).toBeLessThanOrEqual(0.5);",
      ],
      [
        args: [
          "matches",
          { actual: "a"; expected: '"/x+/i"'; stringLike: true },
        ],
        expected: "expect(a).toMatch(/x+/i);",
      ],
      [
        args: ["=", { actual: "a"; isSnapshot: true; snapshotName: '"named"' }],
        expected: 'expect(a).toMatchSnapshot("named");',
      ],
      [
        args: ["=", { actual: "a"; isSnapshot: true }],
        expected: "expect(a).toMatchSnapshot();",
      ],
    ]
  >;

  /** `throws` awaits the rejection, and applies whatever chain it was handed */
  export type Throws_ = Expect<
    Invoke<
      typeof renderCondition,
      [
        "throws",
        {
          actual: "a";
          throwsChain: { matcher: "toThrow"; args: ["RangeError"] };
        },
      ]
    >,
    "=",
    "await expect(a).rejects.toThrow(RangeError);"
  >;

  /** an ordering condition on something that is not a number compares directly */
  export type OrderingOther = Expect<
    Invoke<typeof renderCondition, [">", Operands]>,
    "=",
    "expect(a > b).toBe(true);"
  >;

  /** inside a tuple every expectation reports, so they are soft */
  export type Soft = Expect<
    Invoke<
      typeof renderCondition,
      ["=", { actual: "a"; expected: "b"; expectFn: "expect.soft" }]
    >,
    "=",
    "expect.soft(a).toEqual(b);"
  >;

  /** a condition the DSL does not define prints nothing at all */
  export type Unknown = Expect<
    Invoke<typeof renderCondition, ["nope", Operands]>,
    "=",
    ""
  >;
}

export const regex = (e: string) => {
  const m = /^"\/(.*)\/([a-z]*)"$/.exec(e);
  return m ? `/${m[1]}/${m[2]}` : `new RegExp(${e})`;
};

declare namespace Tests.regex {
  /** a printed "/…/" string is a regex literal; anything else is a source string */
  export type Cases = Table<
    typeof regex,
    [
      [args: [printed: '"/a+/gi"'], expected: "/a+/gi"],
      [args: [printed: '"plain"'], expected: 'new RegExp("plain")'],
    ]
  >;
}

/** The operator of a condition node, plus the parameter of a `["~=", tol]` pair. */
export function condition(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode | typeof THROWS,
): Condition {
  if (node === THROWS) return { op: "throws" };
  if (ts.isTupleTypeNode(node)) {
    const [c, p] = node.elements.map((e) =>
      ts.isNamedTupleMember(e) ? e.type : e,
    );
    if (c && p)
      return {
        op: literalText(inputOrContext, c),
        param: expr(inputOrContext, p),
      };
  }
  return { op: literalText(inputOrContext, node) };
}

/** The 4th argument of Expect: undefined | "./page.html" | { display, displayMeta, … }. */
export function displayConfig(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode | null,
): Display | null {
  if (!node) return null;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return { display: node.literal.text, meta: null };
  if (ts.isTypeLiteralNode(node)) {
    const get = (k: string) =>
      node.members.find(
        (m) =>
          ts.isPropertySignature(m) &&
          ts.isIdentifier(m.name) &&
          m.name.text === k &&
          m.type,
      );
    const d = get("display");
    if (!d || !ts.isPropertySignature(d) || !d.type) return null;
    const meta = get("displayMeta");
    return {
      display: literalText(inputOrContext, d.type),
      meta:
        meta && ts.isPropertySignature(meta) && meta.type
          ? expr(inputOrContext, meta.type)
          : null,
    };
  }
  return null;
}

/**
 * The matcher for a `throws` expectation: nothing, a class/message, or a `ThrowsMatcher` literal.
 * @param e The printed expected value.
 */
export function throwsMatcher(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode | null,
  e: string,
): MatcherChain {
  if (!node || e === "undefined") return chain("toThrow", []);
  if (ts.isTypeLiteralNode(node)) {
    const checks = node.members.map((m) => {
      if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || !m.type)
        return "false";
      const k = m.name.text;
      const v = expr(inputOrContext, m.type);
      if (k === "instanceOf") return `err instanceof ${v}`;
      if (k === "name") return `err.name === ${v}`;
      if (k === "message") return `String(err.message).includes(${v})`;
      if (k === "matches") return `${regex(v)}.test(String(err.message))`;
      return "false";
    });
    return chain("toSatisfy", [`(err) => ${checks.join(" && ")}`]);
  }
  return chain("toThrow", [e]);
}

/** Awaited return type of a function-typed node (for table rows). */
export function returnTypeOf(
  inputOrContextOrChecker: EmitInputOrContext | ts.TypeChecker,
  fnNode: ts.TypeNode,
): ts.Type {
  const checker = isInputOrContext(inputOrContextOrChecker, "program")
    ? asEmitContext(inputOrContextOrChecker).checker
    : inputOrContextOrChecker;
  const t = checker.getTypeFromTypeNode(fnNode);
  const sig = t.getCallSignatures()[0];
  return sig
    ? (checker.getAwaitedType(sig.getReturnType()) ?? sig.getReturnType())
    : t;
}

export const isPrinted = (a: ts.TypeNode | PrintedActual): a is PrintedActual =>
  "code" in a && typeof a.code === "string";

/**
 * One Expect: returns statements.
 * @param actual A type node, or an already-printed expression with its type (table rows).
 * @param condNode `null` means `"="` (2-element table rows).
 * @param configNode Expect's 4th argument.
 * @param anchor The Expect node the statements map to.
 */
export function assertion(
  inputOrContext: EmitInputOrContext,
  actual: ts.TypeNode | PrintedActual,
  condNode: ts.TypeNode | typeof THROWS | null,
  expectedNode: ts.TypeNode | null,
  soft: boolean,
  configNode: ts.TypeNode | null = null,
  anchor: ts.Node | null = null,
): Line[] {
  ensureEmitContext(inputOrContext);
  const display = displayConfig(inputOrContext, configNode);
  if (display) {
    inputOrContext.state.usesTask = true; // this test takes the `{ task }` parameter
    inputOrContext.used.task = true; // the module imports ntCheck
  }
  const actualType = isPrinted(actual)
    ? actual.type
    : inputOrContext.checker.getTypeFromTypeNode(actual);
  const { op, param } = condNode
    ? condition(inputOrContext, condNode)
    : { op: "=" };
  const E = expectedNode ? expr(inputOrContext, expectedNode) : "undefined";
  const isSnapshot = E === "__SNAPSHOT__";
  const snapArg =
    isSnapshot && expectedNode && ts.isTypeReferenceNode(expectedNode)
      ? expectedNode.typeArguments?.[0]
      : undefined;
  const snapshotName = snapArg ? expr(inputOrContext, snapArg) : "";
  const ex = display ? "expect" : soft ? "expect.soft" : "expect";
  const pre: string[] = [];
  const printed = isPrinted(actual)
    ? actual.code
    : expr(inputOrContext, actual);
  let A = printed;
  if (op === "throws") A = `async () => (${printed})`;
  // typed array vs tuple: compare as plain arrays
  else if (
    (op === "=" || op === "!=") &&
    actualType.getProperty("BYTES_PER_ELEMENT") &&
    expectedNode &&
    ts.isTupleTypeNode(expectedNode)
  )
    A = `Array.from(${A})`;
  // hoist expected if it needs an await inside a callback
  let e = E;
  if (
    /\bawait\b/.test(E) &&
    (display || ["satisfies", "some", "every"].includes(op))
  ) {
    pre.push(`const expected = ${E};`);
    e = "expected";
  }
  /**
   * With a display page, route through ntCheck: it runs the same matcher and records raw values on task.meta.
   * @param m The matcher chain, e.g. `.toEqual(3)`.
   */
  const line = (m: string) =>
    display
      ? `await ntCheck(task, { display: ${inputOrContext.quote(display.display)}, meta: ${display.meta ?? "undefined"}, soft: ${soft} }, async () => ${A}, ${e === "undefined" && !isSnapshot ? "undefined" : e}, (actual) => ${ex}(actual)${m});`
      : `${ex}(${A})${m};`;

  const parts: MatcherParts = {
    actual: A,
    expected: e,
    param,
    expectFn: ex,
    numeric: !!(
      actualType.flags &
      (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)
    ),
    stringLike: !!(actualType.flags & ts.TypeFlags.StringLike),
    isSnapshot,
    snapshotName,
    throwsChain:
      op === "throws"
        ? throwsMatcher(inputOrContext, expectedNode, e)
        : chain("toThrow", []),
    hasDisplay: !!display,
    line,
  };

  const expectation = expectationFor(parts, op);
  const stmts = [
    ...pre,
    expectation
      ? renderExpectation(parts, expectation)
      : `${condNode && condNode !== THROWS ? inputOrContext.unsupported(condNode, "is not a known condition") : `nt_unsupported(${inputOrContext.quote(op)})`};`,
  ];
  const anchorNode = anchor ?? (isPrinted(actual) ? null : actual);
  return stmts.map((c) => inputOrContext.statement(c, anchorNode));
}

/**
 * Emit statements for one Test node (Assertion | Sequence | Table | tuple | Modifier).
 * @param soft Inside a tuple: use `expect.soft` so every expectation reports.
 */
/** What an exported alias has to be, said where someone wrote something else. */
const NOT_A_TEST =
  "is not a test: write Expect, Throws, Given or Table (or a tuple of them)";

export function testBody(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode,
  soft: boolean,
): Line[] {
  ensureEmitContext(inputOrContext);
  const stmts: Line[] = [];
  const dsl = ts.isTypeReferenceNode(node)
    ? inputOrContext.dslName(node)
    : null;
  const args = ts.isTypeReferenceNode(node) ? (node.typeArguments ?? []) : [];
  const [a0, a1, a2, a3, a4] = args;
  if (ts.isTupleTypeNode(node)) {
    for (const el of node.elements)
      stmts.push(
        ...testBody(
          inputOrContext,
          ts.isNamedTupleMember(el) ? el.type : el,
          true,
        ),
      );
  } else if (dsl === "Expect") {
    if (a0 && a1)
      stmts.push(
        ...assertion(
          inputOrContext,
          a0,
          a1,
          a2 ?? null,
          soft,
          a3 ?? null,
          node,
        ),
      );
    else
      stmts.push(
        inputOrContext.statement(
          `${arity(inputOrContext, node as ts.TypeReferenceNode, 2)};`,
          node,
        ),
      );
  } else if (dsl === "Throws") {
    if (a0)
      stmts.push(
        ...assertion(inputOrContext, a0, THROWS, a1 ?? null, soft, null, node),
      );
    else
      stmts.push(
        inputOrContext.statement(
          `${arity(inputOrContext, node as ts.TypeReferenceNode, 1)};`,
          node,
        ),
      );
  } else if ((dsl === "Given" || dsl === "ExpectGiven") && a0 && a1) {
    const effects = ts.isTupleTypeNode(a0)
      ? a0.elements.map((e) => (ts.isNamedTupleMember(e) ? e.type : e))
      : [a0];
    for (const e of effects)
      stmts.push(inputOrContext.statement(`${expr(inputOrContext, e)};`, e));
    if (dsl === "Given") stmts.push(...testBody(inputOrContext, a1, soft));
    else if (a2)
      stmts.push(
        ...assertion(
          inputOrContext,
          a1,
          a2,
          a3 ?? null,
          soft,
          a4 ?? null,
          node,
        ),
      );
    else
      stmts.push(
        inputOrContext.statement(
          `${arity(inputOrContext, node as ts.TypeReferenceNode, 3)};`,
          node,
        ),
      );
  } else if (dsl === "Configure" && a1) {
    stmts.push(...testBody(inputOrContext, a1, soft));
  } else if (ts.isTypeReferenceNode(node) && !dsl) {
    // A reference to another test alias (e.g. Skip<Simple>): inline its body.
    const symbol = inputOrContext.checker.getSymbolAtLocation(node.typeName);
    const declaration = symbol?.declarations?.[0];
    if (declaration && ts.isTypeAliasDeclaration(declaration))
      stmts.push(...testBody(inputOrContext, declaration.type, soft));
    else
      stmts.push(
        inputOrContext.statement(
          `${inputOrContext.unsupported(node, NOT_A_TEST)};`,
          node,
        ),
      );
  } else
    stmts.push(
      inputOrContext.statement(
        `${inputOrContext.unsupported(node, NOT_A_TEST)};`,
        node,
      ),
    );
  return stmts;
}

declare namespace Tests.testBody {
  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  /** one `Expect` is one statement */
  export type Assertion_ = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;`]
    >,
    "=",
    ["expect(await add(1, 1)).toEqual(2);"]
  >;

  /** `Given` runs its effects first, then the test underneath */
  export type Effects = Expect<
    Invoke<
      typeof printStatements,
      [
        `${Add}type Subject = Given<Invoke<typeof add, [1, 1]>, Expect<1, "truthy">>;`,
      ]
    >,
    "=",
    ["await add(1, 1);", "expect(1).toBeTruthy();"]
  >;

  /** a tuple of expectations is soft, so every one of them reports */
  export type Tuple = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = [Expect<1, "=", 1>, Expect<2, "=", 2>];`]
    >,
    "=",
    ["expect.soft(1).toEqual(1);", "expect.soft(2).toEqual(2);"]
  >;

  /** `Throws` awaits the rejection of a thunk */
  export type Rejection = Expect<
    Invoke<
      typeof printStatements,
      [`${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>, RangeError>;`]
    >,
    "=",
    ["await expect(async () => (await add(1, 1))).rejects.toThrow(RangeError);"]
  >;
}
