// Type node → IR. This is the only stage that reads the type checker: it
// decides what each node *means* — a literal, a call, a user alias to hoist, a
// DSL intrinsic — and records what cannot be a value as a warning. What it
// hands back (see ir.mts) has no syntax left in it.
import ts from "typescript";

import { isCondition } from "./print.mts";

import type { EmitContext } from "./context.mts";
import type {
  Assertion,
  Binding,
  Expr,
  Shape,
  Statement,
  TestCase,
  TestOptions,
} from "./ir.mts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";
import type * as harness from "../../_internal/harness.mts";

// ── expressions ─────────────────────────────────────────────────────────────

/** A tuple element, without the label of a named member. */
const unwrap = (e: ts.TypeNode): ts.TypeNode =>
  ts.isNamedTupleMember(e) ? e.type : e;

const elements = (tuple: ts.TupleTypeNode) => tuple.elements.map(unwrap);

/** What a type node stands for, as an expression. */
export function lowerExpr(cx: EmitContext, node: ts.TypeNode): Expr {
  if (ts.isParenthesizedTypeNode(node))
    return { kind: "paren", inner: lowerExpr(cx, node.type) };
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))
      return { kind: "string", value: lit.text };
    if (ts.isPrefixUnaryExpression(lit))
      return { kind: "literal", source: `-${lit.operand.getText()}` };
    return { kind: "literal", source: lit.getText() }; // true, false, null, 1, 10n
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword)
    return { kind: "literal", source: "undefined" };
  // only legal as the ignored expected of a nullary table row
  if (node.kind === ts.SyntaxKind.NeverKeyword)
    return { kind: "literal", source: "undefined" };
  if (ts.isTemplateLiteralTypeNode(node))
    return node.templateSpans.length === 0
      ? { kind: "string", value: node.head.text }
      : fold(cx, node); // the checker may reduce it to one string
  if (ts.isTupleTypeNode(node))
    return {
      kind: "array",
      elements: elements(node).map((e) => lowerExpr(cx, e)),
    };
  if (ts.isTypeLiteralNode(node))
    return {
      kind: "object",
      entries: node.members.map((m) => {
        const key =
          m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
            ? m.name.text
            : (m.name?.getText() ?? "");
        return ts.isPropertySignature(m) && m.type
          ? [key, lowerExpr(cx, m.type)]
          : [key, cx.unsupported(m)];
      }),
    };
  if (ts.isTypeQueryNode(node)) return lowerName(cx, node.exprName); // typeof x.y
  if (ts.isIndexedAccessTypeNode(node)) {
    const index = node.indexType;
    if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal))
      return {
        kind: "index",
        object: lowerExpr(cx, node.objectType),
        key: index.literal.text,
      };
    if (ts.isLiteralTypeNode(index) && ts.isNumericLiteral(index.literal))
      return {
        kind: "index",
        object: lowerExpr(cx, node.objectType),
        key: Number(index.literal.text),
      };
    return cx.unsupported(node);
  }
  if (ts.isTypeReferenceNode(node)) return lowerReference(cx, node);
  return fold(cx, node);
}

declare namespace lowerExpr {
  /** a type literal prints as the value literal it describes */
  export type Literals = Table<
    typeof harness.printExpression,
    [
      [
        args: [
          source: 'type Subject = [1, "a", true, null, undefined, -2, 10n];',
        ],
        expected: '[1, "a", true, null, undefined, -2, 10n]',
      ],
      [
        args: ['type Subject = { a: 1; "b-c": 2 };'],
        expected: '{ a: 1, "b-c": 2 }',
      ],
      [args: ["type Subject = `plain`;"], expected: '"plain"'],
    ]
  >;

  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  /** `Invoke` is the call it stands for, awaited */
  export type Invocation = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}\ntype Subject = Invoke<typeof add, [4, 5]>;`]
    >,
    "=",
    "await add(4, 5)"
  >;

  /** an alias the test references is hoisted into a const, so this is its name */
  export type AliasReference = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}type Sum = Invoke<typeof add, [1, 2]>;\ntype Subject = Sum;`]
    >,
    "=",
    "Sum"
  >;

  /** reading the environment goes through a helper unless a default is given */
  export type Environment = Table<
    typeof harness.printExpression,
    [
      [args: ['type Subject = Env<"TOKEN">;'], expected: 'nt_env("TOKEN")'],
      [
        args: [source: 'type Subject = Env<"TOKEN", "fallback">;'],
        expected: '(process.env["TOKEN"] ?? "fallback")',
      ],
    ]
  >;

  /** what the compiler works out itself — `Uppercase<…>` and its siblings */
  export type Intrinsics = Table<
    typeof harness.printExpression,
    [
      [args: ['type Subject = Uppercase<"ab">;'], expected: '"AB"'],
      [args: ['type Subject = Capitalize<"ab">;'], expected: '"Ab"'],
      [
        args: ['type Subject = [Lowercase<"AB">, Uncapitalize<"AB">];'],
        expected: '["ab", "aB"]',
      ],
    ]
  >;

  /** what cannot be a value throws when the test runs, and is reported now */
  export type NotAValue = Expect<
    Invoke<typeof harness.printExpression, ["type Subject = number;"]>,
    "=",
    'nt_unsupported("number")'
  >;

  export type NotAValueWarns = Expect<
    Invoke<typeof harness.expressionWarnings, ["type Subject = number;"]>,
    "=",
    ["`number` is a type, not a value"]
  >;

  /** a DSL intrinsic given too few arguments says how many it wants */
  export type Arity = Expect<
    Invoke<
      typeof harness.expressionWarnings,
      [`${Add}type Subject = Invoke<typeof add>;`]
    >,
    "=",
    ["`Invoke<typeof add>` expects 2 type arguments"]
  >;

  /** an awaited receiver is parenthesised before its method is called */
  export type AwaitedReceiver = Expect<
    Invoke<
      typeof harness.printExpression,
      [`${Add}type Subject = Call<Invoke<typeof add, [1, 2]>, "toFixed", [1]>;`]
    >,
    "=",
    "await (await add(1, 2)).toFixed(1)"
  >;
}

/** `a.b.c` from a qualified name, resolving the root identifier as a value. */
export function lowerName(cx: EmitContext, node: ts.EntityName): Expr {
  if (ts.isIdentifier(node)) {
    const name = cx.valueName(node);
    return typeof name === "string" ? { kind: "name", name } : name;
  }
  const left = lowerName(cx, node.left);
  return left.kind === "name"
    ? { kind: "name", name: `${left.name}.${node.right.text}` }
    : left;
}

/** The arity a DSL intrinsic was given too few arguments for. */
const arity = (cx: EmitContext, node: ts.TypeReferenceNode, n: number): Expr =>
  cx.unsupported(node, `expects ${n} type argument${n === 1 ? "" : "s"}`);

/** `typeof f` as the thing to call, or any other expression. */
const callee = (cx: EmitContext, node: ts.TypeNode): Expr =>
  ts.isTypeQueryNode(node) ? lowerName(cx, node.exprName) : lowerExpr(cx, node);

/** The arguments of a call: a tuple, element by element. */
const args = (cx: EmitContext, node: ts.TypeNode): Expr[] =>
  ts.isTupleTypeNode(node)
    ? elements(node).map((e) => lowerExpr(cx, e))
    : [cx.unsupported(node)];

/** The string a string-literal type node holds (or whatever the checker folds it to). */
export const literalText = (cx: EmitContext, node: ts.TypeNode): string =>
  ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    ? node.literal.text
    : cx.checker
        .typeToString(cx.checker.getTypeFromTypeNode(node))
        .replace(/^"|"$/g, "");

/** A DSL intrinsic applied to its type arguments. */
function lowerIntrinsic(
  cx: EmitContext,
  dsl: string,
  node: ts.TypeReferenceNode,
): Expr {
  const [a0, a1, a2] = node.typeArguments ?? [];
  switch (dsl) {
    case "Invoke":
      return a0 && a1
        ? { kind: "call", callee: callee(cx, a0), args: args(cx, a1) }
        : arity(cx, node, 2);
    case "Construct":
      return a0 && a1
        ? { kind: "construct", callee: callee(cx, a0), args: args(cx, a1) }
        : arity(cx, node, 2);
    case "Call":
      return a0 && a1 && a2
        ? {
            kind: "method",
            receiver: lowerExpr(cx, a0),
            method: literalText(cx, a1),
            args: args(cx, a2),
          }
        : arity(cx, node, 3);
    case "Fixture":
      return a1 ? lowerExpr(cx, a1) : arity(cx, node, 2);
    case "Widen":
      return a0 ? lowerExpr(cx, a0) : arity(cx, node, 1);
    case "FromFile": {
      if (!a0) return arity(cx, node, 1);
      const format = a1 ? literalText(cx, a1) : "text";
      return {
        kind: "file",
        path: lowerExpr(cx, a0),
        format: format === "bytes" || format === "json" ? format : "text",
      };
    }
    case "Env":
      return a0
        ? {
            kind: "env",
            name: literalText(cx, a0),
            fallback:
              a1 && a1.kind !== ts.SyntaxKind.UndefinedKeyword
                ? lowerExpr(cx, a1)
                : null,
          }
        : arity(cx, node, 1);
    case "Snapshot":
      return { kind: "snapshot", name: a0 ? lowerExpr(cx, a0) : null };
    case "Nothing":
      return { kind: "literal", source: "undefined" };
    default:
      return cx.unsupported(node, `${dsl} is not a value`);
  }
}

/**
 * `Uppercase<S>` and its siblings are declared as `= intrinsic`: there is no
 * body to inline, and the compiler evaluates them itself. So they are left to
 * the checker to fold, like any other type it can work out.
 */
const isIntrinsic = (declaration: ts.TypeAliasDeclaration) =>
  declaration.type.kind === ts.SyntaxKind.IntrinsicKeyword;

/** A `TypeReference`: DSL intrinsic, user alias, class, or something the checker can fold. */
function lowerReference(cx: EmitContext, node: ts.TypeReferenceNode): Expr {
  const dsl = cx.dslName(node);
  if (dsl) return lowerIntrinsic(cx, dsl, node);
  const target = cx.target(node.typeName);
  const declaration = target?.declarations?.[0];
  if (
    target &&
    declaration &&
    ts.isTypeAliasDeclaration(declaration) &&
    !isIntrinsic(declaration)
  ) {
    const binding = register(cx, target, declaration);
    const name: Expr = { kind: "name", name: binding.name };
    return binding.params
      ? {
          kind: "call",
          callee: name,
          args: (node.typeArguments ?? []).map((a) => lowerExpr(cx, a)),
        }
      : name;
  }
  if (declaration && ts.isTypeParameterDeclaration(declaration))
    return { kind: "name", name: declaration.name.text }; // inside a generic alias body
  // A class (or lib interface+var pair such as RangeError) written as a type: use the value.
  if (target && target.flags & ts.SymbolFlags.Value)
    return lowerName(cx, node.typeName);
  return fold(cx, node);
}

/** Register a user alias as a binding of the current test, dependencies first. */
function register(
  cx: EmitContext,
  symbol: ts.Symbol,
  decl: ts.TypeAliasDeclaration,
): Binding {
  const existing = cx.test.bindings.get(symbol);
  if (existing) return existing;
  const clashes = cx.checker.resolveName(
    decl.name.text,
    decl,
    ts.SymbolFlags.Value,
    false,
  );
  const binding: Binding = {
    name: clashes ? `${decl.name.text}$` : decl.name.text,
    params:
      decl.typeParameters?.map((p) => ({
        name: p.name.text,
        type: p.constraint?.getText() ?? "unknown",
        // `Key<"a.ts", "T">` leaves a defaulted parameter out, and means the
        // default by doing so; the printed parameter has to stand in for it the
        // same way, or the call arrives one argument short
        fallback: p.default ? lowerExpr(cx, p.default) : null,
      })) ?? null,
    // `Fixture<T, I>` keeps `T` on the const, so the generated code re-checks the DSL's guarantee
    annotation:
      ts.isTypeReferenceNode(decl.type) && cx.dslName(decl.type) === "Fixture"
        ? (decl.type.typeArguments?.[0]?.getText() ?? null)
        : null,
    value: { kind: "literal", source: "" },
    line: cx.lineOf(decl),
  };
  cx.test.bindings.set(symbol, binding);
  binding.value = lowerExpr(cx, decl.type); // may register further aliases first
  cx.test.order.push(binding);
  return binding;
}

/** Anything else: if the checker can reduce it to a literal shape, print that. */
function fold(cx: EmitContext, node: ts.TypeNode): Expr {
  return (
    literalOfType(cx, cx.checker.getTypeFromTypeNode(node)) ??
    cx.unsupported(node)
  );
}

/** A type the checker has already reduced, as a value literal — or null. */
export function literalOfType(cx: EmitContext, type: ts.Type): Expr | null {
  const { checker } = cx;
  if (type.flags & ts.TypeFlags.StringLiteral)
    return { kind: "string", value: (type as ts.StringLiteralType).value };
  if (type.flags & ts.TypeFlags.NumberLiteral)
    return {
      kind: "literal",
      source: String((type as ts.NumberLiteralType).value),
    };
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const { negative, base10Value } = (type as ts.BigIntLiteralType).value;
    return { kind: "literal", source: `${negative ? "-" : ""}${base10Value}n` };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return { kind: "literal", source: checker.typeToString(type) };
  if (type.flags & ts.TypeFlags.Null)
    return { kind: "literal", source: "null" };
  if (type.flags & ts.TypeFlags.Undefined)
    return { kind: "literal", source: "undefined" };
  if (checker.isTupleType(type)) {
    const items = checker
      .getTypeArguments(type as ts.TypeReference)
      .map((arg) => literalOfType(cx, arg));
    return items.every((i) => i !== null)
      ? { kind: "array", elements: items }
      : null;
  }
  if (
    type.flags & ts.TypeFlags.Object &&
    !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Class)
  ) {
    const entries: [string, Expr][] = [];
    for (const p of type.getProperties()) {
      const value = literalOfType(cx, checker.getTypeOfSymbol(p));
      if (!value) return null;
      entries.push([p.getName(), value]);
    }
    return { kind: "object", entries };
  }
  return null;
}

// ── assertions ──────────────────────────────────────────────────────────────

/** What the matcher needs to know about the actual's type. */
export function shapeOf(type: ts.Type): Shape {
  if (type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike))
    return "number";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.getProperty("BYTES_PER_ELEMENT")) return "typedArray";
  return "other";
}

/** The condition node of an `Expect`: `"="`, or `["~=", tolerance]`. */
function lowerCondition(
  cx: EmitContext,
  node: ts.TypeNode,
): { op: string; param: Expr | null } {
  if (ts.isTupleTypeNode(node)) {
    const [op, param] = elements(node);
    if (op && param)
      return { op: literalText(cx, op), param: lowerExpr(cx, param) };
  }
  return { op: literalText(cx, node), param: null };
}

/** Expect's 4th argument: `"./page.html"` or `{ display, displayMeta, … }`. */
export function lowerDisplay(
  cx: EmitContext,
  node: ts.TypeNode | undefined,
): Assertion["display"] {
  if (!node) return null;
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return { page: node.literal.text, meta: null };
  if (!ts.isTypeLiteralNode(node)) return null;
  const property = (key: string) =>
    node.members.find(
      (m): m is ts.PropertySignature & { type: ts.TypeNode } =>
        ts.isPropertySignature(m) &&
        ts.isIdentifier(m.name) &&
        m.name.text === key &&
        !!m.type,
    )?.type;
  const page = property("display");
  const meta = property("displayMeta");
  return page
    ? { page: literalText(cx, page), meta: meta ? lowerExpr(cx, meta) : null }
    : null;
}

/** An already-lowered actual with its type: what a table row calls. */
export type Actual = { expr: Expr; type: ts.Type };

/** What an exported alias has to be, said where someone wrote something else. */
const NOT_A_TEST =
  "is not a test: write Expect, Throws, Given or Table (or a tuple of them)";

const effect = (expr: Expr, line: number): Statement => ({
  kind: "effect",
  expr,
  line,
});

/**
 * One `Expect`, `Throws` or table row, as a statement.
 * @param condition A condition node, or the condition itself when the syntax implies it.
 * @param anchor The node the statement is reported at.
 */
export function assertion(
  cx: EmitContext,
  actual: ts.TypeNode | Actual,
  condition: ts.TypeNode | "=" | "throws",
  expected: ts.TypeNode | undefined,
  soft: boolean,
  config: ts.TypeNode | undefined,
  anchor: ts.Node,
): Statement {
  const line = cx.lineOf(anchor);
  const display = lowerDisplay(cx, config);
  const { op, param } =
    typeof condition === "string"
      ? { op: condition, param: null }
      : lowerCondition(cx, condition);
  const expectedExpr = expected ? lowerExpr(cx, expected) : null;
  const expr = "expr" in actual ? actual.expr : lowerExpr(cx, actual);
  const type =
    "expr" in actual ? actual.type : cx.checker.getTypeFromTypeNode(actual);
  // only a node can name a condition the DSL does not have
  if (!isCondition(op) && typeof condition !== "string")
    return effect(cx.unsupported(condition, "is not a known condition"), line);
  if (!isCondition(op))
    throw new Error(`namespace-tests: no such condition ${op}`);
  return {
    kind: "assert",
    line,
    actual: expr,
    shape: shapeOf(type),
    condition: op,
    param,
    expected: expectedExpr,
    soft,
    display,
  };
}

// ── test bodies ─────────────────────────────────────────────────────────────

/**
 * The statements of one Test node: an assertion, a `Given` sequence, a tuple
 * of tests (soft, so every one of them reports), or a reference to another
 * test alias, inlined.
 */
export function lowerBody(
  cx: EmitContext,
  node: ts.TypeNode,
  soft: boolean,
): Statement[] {
  if (ts.isTupleTypeNode(node))
    return elements(node).flatMap((e) => lowerBody(cx, e, true));
  const notATest = () => [
    effect(cx.unsupported(node, NOT_A_TEST), cx.lineOf(node)),
  ];
  if (!ts.isTypeReferenceNode(node)) return notATest();
  const dsl = cx.dslName(node);
  const [a0, a1, a2, a3, a4] = node.typeArguments ?? [];
  const short = (n: number) => [effect(arity(cx, node, n), cx.lineOf(node))];
  switch (dsl) {
    case "Expect":
      return a0 && a1 ? [assertion(cx, a0, a1, a2, soft, a3, node)] : short(2);
    case "Throws":
      return a0
        ? [assertion(cx, a0, "throws", a1, soft, undefined, node)]
        : short(1);
    case "Given":
    case "ExpectGiven": {
      if (!a0 || !a1) return notATest();
      const effects = (ts.isTupleTypeNode(a0) ? elements(a0) : [a0]).map((e) =>
        effect(lowerExpr(cx, e), cx.lineOf(e)),
      );
      const then =
        dsl === "Given"
          ? lowerBody(cx, a1, soft)
          : a2
            ? [assertion(cx, a1, a2, a3, soft, a4, node)]
            : short(3);
      return [...effects, ...then];
    }
    case "Configure":
      return a1 ? lowerBody(cx, a1, soft) : short(2);
    case null: {
      // A reference to another test alias (e.g. `Skip<Simple>`): inline its body.
      const declaration = cx.target(node.typeName)?.declarations?.[0];
      return declaration && ts.isTypeAliasDeclaration(declaration)
        ? lowerBody(cx, declaration.type, soft)
        : notATest();
    }
    default:
      return notATest();
  }
}

declare namespace lowerBody {
  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  /** one `Expect` is one statement */
  export type Assertion_ = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${Add}type Subject = Expect<Invoke<typeof add, [1, 1]>, "=", 2>;`]
    >,
    "=",
    ["expect(await add(1, 1)).toEqual(2);"]
  >;

  /** `Given` runs its effects first, then the test underneath */
  export type Effects = Expect<
    Invoke<
      typeof harness.printStatements,
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
      typeof harness.printStatements,
      [`${Add}type Subject = [Expect<1, "=", 1>, Expect<2, "=", 2>];`]
    >,
    "=",
    ["expect.soft(1).toEqual(1);", "expect.soft(2).toEqual(2);"]
  >;

  /** `Throws` awaits the rejection of a thunk */
  export type Rejection = Expect<
    Invoke<
      typeof harness.printStatements,
      [`${Add}type Subject = Throws<Invoke<typeof add, [1, 1]>, RangeError>;`]
    >,
    "=",
    ["await expect(async () => (await add(1, 1))).rejects.toThrow(RangeError);"]
  >;

  /** what is not a test says so where it was written, and fails when run */
  export type NotATest = Expect<
    Invoke<typeof harness.printStatements, ["type Subject = 1;"]>,
    "=",
    ['nt_unsupported("1");']
  >;
}

// ── test aliases ────────────────────────────────────────────────────────────

/** The name Vitest reports for a test: its namespace path, then the alias. */
export const testName = (path: string[], alias: string): string =>
  [...path, alias].join(" > ");

declare namespace testName {
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
 * model has a go at it, and says so where it cannot.
 */
export function isTest(cx: EmitContext, type: ts.TypeNode): boolean {
  if (ts.isTupleTypeNode(type))
    return (
      type.elements.length > 0 && elements(type).every((e) => isTest(cx, e))
    );
  return ts.isTypeReferenceNode(type) && !!cx.dslName(type);
}

declare namespace isTest {
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
    Invoke<typeof harness.testNames, [Suite]>,
    "=",
    [
      "anything > Assertion",
      "anything > Skipped",
      "anything > Pending",
      "anything > Rows[0]",
      "anything > Value",
    ]
  >;

  /** an exported alias that is not the DSL's at all is not a test */
  export type NotOurs = Expect<
    Invoke<typeof harness.testNames, [Suite]>,
    "excludes",
    "anything > Helper"
  >;

  /**
   * `Value` is the DSL's, so it is collected — and the model is the one that
   * says it cannot be run, reported where it is written.
   */
  export type SaysWhy = Expect<
    Invoke<typeof harness.moduleWarnings, [Suite]>,
    "=",
    [
      "`Invoke<typeof add, [1, 1]>` is not a test: write Expect, Throws, Given or Table (or a tuple of them)",
    ]
  >;
}

/** A test alias after its modifiers are peeled off. */
type Peeled = {
  mode: TestCase["mode"];
  options: TestOptions;
  node: ts.TypeNode | null;
};

/** Strip `Skip` / `Only` / `Todo` / `Configure` wrappers, collecting what they mean. */
export function peelModifiers(cx: EmitContext, type: ts.TypeNode): Peeled {
  let node: ts.TypeNode | null = type;
  let mode: TestCase["mode"] = "test";
  const options: TestOptions = {};
  while (node && ts.isTypeReferenceNode(node)) {
    const dsl = cx.dslName(node);
    const m0: ts.TypeNode | undefined = node.typeArguments?.[0];
    const m1: ts.TypeNode | undefined = node.typeArguments?.[1];
    if (dsl === "Skip" && m0) [mode, node] = ["test.skip", m0];
    else if (dsl === "Only" && m0) [mode, node] = ["test.only", m0];
    else if (dsl === "Todo") [mode, node] = ["test.todo", null];
    else if (dsl === "Configure" && m0 && m1) {
      if (ts.isTypeLiteralNode(m0))
        for (const m of m0.members) {
          if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || !m.type)
            continue;
          const value = Number(m.type.getText().replace(/_/g, ""));
          if (m.name.text === "timeout") options.timeout = value;
          if (m.name.text === "retries") options.retry = value;
        }
      node = m1;
    } else break;
  }
  return { mode, options, node };
}

/** The JSDoc comment on a test alias, which becomes its description. */
export function docTextOf(decl: ts.TypeAliasDeclaration): string | null {
  const doc = ts.getJSDocCommentsAndTags(decl).find(ts.isJSDoc)?.comment;
  return doc === undefined
    ? null
    : typeof doc === "string"
      ? doc
      : doc.map((c) => c.text).join("");
}

/** Awaited return type of a function-typed node (for table rows). */
function returnTypeOf(cx: EmitContext, fnNode: ts.TypeNode): ts.Type {
  const { checker } = cx;
  const t = checker.getTypeFromTypeNode(fnNode);
  const sig = t.getCallSignatures()[0];
  return sig
    ? (checker.getAwaitedType(sig.getReturnType()) ?? sig.getReturnType())
    : t;
}

/** A `Table<fn, rows>`: one test per row. */
function tableCases(
  cx: EmitContext,
  node: ts.TypeReferenceNode,
  meta: Omit<TestCase, "bindings" | "body" | "imports">,
): TestCase[] {
  const [fnNode, rowsNode] = node.typeArguments ?? [];
  const failing = (at: ts.Node, why: string, row = meta): TestCase => ({
    ...row,
    mode: "test",
    bindings: [],
    imports: new Map(),
    body: [effect(cx.unsupported(at, why), cx.lineOf(at))],
  });
  if (!fnNode || !rowsNode || !ts.isTupleTypeNode(rowsNode))
    return [failing(node, "expects a function and a tuple of rows")];
  return elements(rowsNode).map((row, i) => {
    cx.resetTest();
    const rowMeta = {
      ...meta,
      name: testName(meta.path, `${meta.alias}[${i}]`),
      row: i,
      line: cx.lineOf(row),
    };
    if (!ts.isTupleTypeNode(row))
      return failing(row, "is not a table row", rowMeta);
    const cells = elements(row);
    const [argsNode, condition, expected] =
      cells.length === 2 ? [cells[0], null, cells[1]] : cells;
    if (!argsNode) return failing(row, "is not a table row", rowMeta);
    const call: Actual = {
      expr: {
        kind: "call",
        callee: callee(cx, fnNode),
        args: args(cx, argsNode),
      },
      type: returnTypeOf(cx, fnNode),
    };
    const body = [
      assertion(cx, call, condition ?? "=", expected, false, undefined, row),
    ];
    return {
      ...rowMeta,
      bindings: cx.test.order,
      imports: cx.test.imports,
      body,
    };
  });
}

/**
 * One exported test alias, as test cases: a `Table<…>` yields one per row,
 * everything else exactly one.
 * @param path The namespace segments the alias was written in.
 */
export function lowerAlias(
  cx: EmitContext,
  decl: ts.TypeAliasDeclaration,
  path: string[] = [],
): TestCase[] {
  cx.resetTest();
  const alias = decl.name.text;
  const line = cx.lineOf(decl);
  const { mode, options, node } = peelModifiers(cx, decl.type);
  const text = docTextOf(decl);
  const meta = {
    name: testName(path, alias),
    path,
    alias,
    row: null,
    line,
    doc: text === null ? null : { text, line },
    mode,
    options,
  };
  if (!node) return [{ ...meta, bindings: [], imports: new Map(), body: [] }];
  if (ts.isTypeReferenceNode(node) && cx.dslName(node) === "Table")
    return tableCases(cx, node, meta);
  const body = lowerBody(cx, node, false);
  return [{ ...meta, bindings: cx.test.order, imports: cx.test.imports, body }];
}

/**
 * Every namespace block with its flattened dotted name (`declare namespace A.B
 * {}` → `["A", "B"]`), a nested block after the one that holds it. Only
 * statements are looked at: an ambient namespace cannot sit inside a function.
 */
export function* namespaces(
  node: ts.SourceFile | ts.ModuleBlock,
  prefix: string[] = [],
): Generator<{ segs: string[]; body: ts.ModuleBlock }> {
  for (const statement of node.statements) {
    if (!ts.isModuleDeclaration(statement) || !ts.isIdentifier(statement.name))
      continue;
    const segs = [...prefix, statement.name.text];
    let body = statement.body;
    while (body && ts.isModuleDeclaration(body) && ts.isIdentifier(body.name)) {
      segs.push(body.name.text);
      body = body.body;
    }
    if (body && ts.isModuleBlock(body)) {
      yield { segs, body };
      yield* namespaces(body, segs);
    }
  }
}

/** `export type X = …`: the only kind of statement that can be a test. */
export const isExportedTypeAlias = (
  node: ts.Statement,
): node is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(node) &&
  !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

declare namespace lowerAlias {
  type Suite = `
    const add = (a: number, b: number) => a + b;
    declare namespace add {
      /** four plus five */
      export type Simple = Expect<Invoke<typeof add, [4, 5]>, "=", 9>;
      export type Rows = Table<typeof add, [[[1, 1], "=", 2]]>;
      export type Later = Todo<"soon">;
      export type Skipped = Skip<Expect<1, "=", 1>>;
      export type SkippedRows = Skip<Table<typeof add, [[[1, 1], "=", 2]]>>;
      export type Slow = Configure<{ timeout: 50; retries: 2 }, Expect<1, "=", 1>>;
    }
  `;

  /** a test alias becomes one top-level test, its JSDoc kept as the description */
  export type Simple = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Simple"]>,
    "=",
    '/** four plus five */\ntest("add > Simple", async () => {\n  expect(await add(4, 5)).toEqual(9);\n});'
  >;

  /** a table row is a test of its own, indexed by row */
  export type TableRow = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Rows"]>,
    "=",
    'test("add > Rows[0]", async () => {\n  expect(await add(1, 1)).toEqual(2);\n});'
  >;

  /** `Todo` has no body at all */
  export type Pending = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Later"]>,
    "=",
    'test.todo("add > Later");'
  >;

  /** `Skip` picks the Vitest function, and keeps the test underneath — rows included */
  export type Skipped = [
    Expect<
      Invoke<typeof harness.printAlias, [Suite, "Skipped"]>,
      "startsWith",
      'test.skip("add > Skipped"'
    >,
    Expect<
      Invoke<typeof harness.printAlias, [Suite, "SkippedRows"]>,
      "startsWith",
      'test.skip("add > SkippedRows[0]"'
    >,
  ];

  /** `Configure` becomes Vitest's own options */
  export type Configured = Expect<
    Invoke<typeof harness.printAlias, [Suite, "Slow"]>,
    "startsWith",
    'test("add > Slow", {"timeout":50,"retry":2}, async () => {'
  >;
}
