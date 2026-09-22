// Type node → JS expression. A TypeScript *type* literal is printed as the
// equivalent *value* literal; DSL intrinsics (`Invoke`, `Construct`, …) print
// as the call they stand for; a user alias is hoisted into a `const`.
import ts from "typescript";
import {
  asEmitContext,
  ensureEmitContext,
  isInputOrContext,
} from "./context.mts";
import type { Alias, EmitContext, EmitInputOrContext } from "./context.mts";

import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";
import type {
  expressionWarnings,
  printExpression,
} from "../../_internal/harness.mts";
/** Print a type node as a JS expression. */
export function expr(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode,
): string {
  ensureEmitContext(inputOrContext);
  if (ts.isParenthesizedTypeNode(node))
    return `(${expr(inputOrContext, node.type)})`;
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal;
    if (lit.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return "true";
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return "false";
    if (ts.isPrefixUnaryExpression(lit)) return `-${lit.operand.getText()}`;
    if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))
      return inputOrContext.quote(lit.text);
    return lit.getText(); // numeric / bigint literal
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (node.kind === ts.SyntaxKind.NeverKeyword) return "undefined"; // only legal as the ignored expected of a nullary table row
  if (ts.isTemplateLiteralTypeNode(node))
    return node.templateSpans.length === 0
      ? inputOrContext.quote(node.head.text)
      : // a template with substitutions is still printable when the checker
        // can reduce the whole thing to one string literal
        fold(inputOrContext, node);
  if (ts.isTupleTypeNode(node))
    return `[${node.elements.map((e) => expr(inputOrContext, ts.isNamedTupleMember(e) ? e.type : e)).join(", ")}]`;
  if (ts.isTypeLiteralNode(node)) {
    return `{ ${node.members
      .map((m) => {
        if (!ts.isPropertySignature(m) || !m.type)
          return inputOrContext.unsupported(m);
        const name =
          ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
            ? m.name.text
            : m.name.getText();
        return `${inputOrContext.propKey(name)}: ${expr(inputOrContext, m.type)}`;
      })
      .join(", ")} }`;
  }
  if (ts.isTypeQueryNode(node))
    return entityName(inputOrContext, node.exprName); // typeof x, typeof a.b
  if (ts.isIndexedAccessTypeNode(node)) {
    const idx = node.indexType;
    const o = expr(inputOrContext, node.objectType);
    const obj = /^(await|new)\b/.test(o) ? `(${o})` : o;
    if (ts.isLiteralTypeNode(idx) && ts.isStringLiteral(idx.literal))
      return /^[A-Za-z_$][\w$]*$/.test(idx.literal.text)
        ? `${obj}.${idx.literal.text}`
        : `${obj}[${inputOrContext.quote(idx.literal.text)}]`;
    if (ts.isLiteralTypeNode(idx) && ts.isNumericLiteral(idx.literal))
      return `${obj}[${idx.literal.text}]!`; // `!`: type-level X[0] is never undefined; value-level x[0] may be under noUncheckedIndexedAccess
    return inputOrContext.unsupported(node);
  }
  if (ts.isTypeReferenceNode(node)) return reference(inputOrContext, node);
  return fold(inputOrContext, node);
}

declare namespace Tests.expr {
  type Add = `
    const add = (a: number, b: number) => a + b;
  `;

  /** a type literal prints as the value literal it describes */
  export type Literals = Table<
    typeof printExpression,
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

  /** `Invoke` is the call it stands for, awaited */
  export type Invocation = Expect<
    Invoke<
      typeof printExpression,
      [`${Add}type Subject = Invoke<typeof add, [4, 5]>;`]
    >,
    "=",
    "await add(4, 5)"
  >;

  /** an alias the test references is hoisted into a const, so this is its name */
  export type AliasReference = Expect<
    Invoke<
      typeof printExpression,
      [`${Add}type Sum = Invoke<typeof add, [1, 2]>;\ntype Subject = Sum;`]
    >,
    "=",
    "Sum"
  >;

  /** reading the environment goes through a helper unless a default is given */
  export type Environment = Table<
    typeof printExpression,
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
    typeof printExpression,
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
    Invoke<typeof printExpression, ["type Subject = number;"]>,
    "=",
    'nt_unsupported("number")'
  >;

  export type NotAValueWarns = Expect<
    Invoke<typeof expressionWarnings, ["type Subject = number;"]>,
    "=",
    ["`number` is a type, not a value"]
  >;

  /** a DSL intrinsic given too few arguments says how many it wants */
  export type Arity = Expect<
    Invoke<
      typeof expressionWarnings,
      [`${Add}type Subject = Invoke<typeof add>;`]
    >,
    "=",
    ["`Invoke<typeof add>` expects 2 type arguments"]
  >;
}

/** `a.b.c` from a qualified name, resolving the root identifier as a value. */
export function entityName(
  inputOrContext: EmitInputOrContext,
  node: ts.EntityName,
): string {
  ensureEmitContext(inputOrContext);
  return ts.isIdentifier(node)
    ? inputOrContext.valueName(node)
    : `${entityName(inputOrContext, node.left)}.${node.right.text}`;
}

/** A `TypeReference`: DSL intrinsic, user alias, class, or something the checker can fold. */
export function reference(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeReferenceNode,
): string {
  ensureEmitContext(inputOrContext);
  const args = node.typeArguments ?? [];
  const dsl = inputOrContext.dslName(node);
  if (dsl) {
    const [a0, a1, a2] = args;
    switch (dsl) {
      case "Invoke":
        return a0 && a1
          ? `await ${callee(inputOrContext, a0)}(${tupleArgs(inputOrContext, a1)})`
          : arity(inputOrContext, node, 2);
      case "Construct":
        return a0 && a1
          ? `new ${callee(inputOrContext, a0)}(${tupleArgs(inputOrContext, a1)})`
          : arity(inputOrContext, node, 2);
      case "Call":
        return a0 && a1 && a2
          ? `await ${expr(inputOrContext, a0)}.${inputOrContext.propKey(literalText(inputOrContext, a1))}(${tupleArgs(inputOrContext, a2)})`
          : arity(inputOrContext, node, 3);
      case "Fixture":
        return a1 ? expr(inputOrContext, a1) : arity(inputOrContext, node, 2);
      case "Widen":
        return a0 ? expr(inputOrContext, a0) : arity(inputOrContext, node, 1);
      case "FromFile": {
        if (!a0) return arity(inputOrContext, node, 1);
        inputOrContext.used.fs = true;
        const fmt = a1 ? literalText(inputOrContext, a1) : "text";
        const url = `new URL(${expr(inputOrContext, a0)}, import.meta.url)`;
        return fmt === "bytes"
          ? `new Uint8Array(readFileSync(${url}))`
          : fmt === "json"
            ? `JSON.parse(readFileSync(${url}, "utf8"))`
            : `readFileSync(${url}, "utf8")`;
      }
      case "Env": {
        if (!a0) return arity(inputOrContext, node, 1);
        const name = inputOrContext.quote(literalText(inputOrContext, a0));
        if (a1 && a1.kind !== ts.SyntaxKind.UndefinedKeyword)
          return `(process.env[${name}] ?? ${expr(inputOrContext, a1)})`;
        inputOrContext.used.env = true;
        return `nt_env(${name})`;
      }
      case "Snapshot":
        return "__SNAPSHOT__";
      case "Nothing":
        return "undefined";
      default:
        return inputOrContext.unsupported(node, `${dsl} is not a value`);
    }
  }
  const symbol = inputOrContext.checker.getSymbolAtLocation(node.typeName);
  const target =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? inputOrContext.checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = target?.declarations?.[0];
  if (
    target &&
    declaration &&
    ts.isTypeAliasDeclaration(declaration) &&
    !isIntrinsic(declaration)
  ) {
    const a = registerAlias(inputOrContext, target, declaration);
    return a.generic
      ? `await ${a.name}(${args.map((arg) => expr(inputOrContext, arg)).join(", ")})`
      : a.name;
  }
  if (declaration && ts.isTypeParameterDeclaration(declaration))
    return declaration.name.text; // inside a generic alias body
  // A class (or lib interface+var pair such as RangeError) written as a type: use the value.
  if (target && target.flags & ts.SymbolFlags.Value)
    return entityName(inputOrContext, node.typeName);
  return fold(inputOrContext, node);
}

/**
 * `Uppercase<S>` and its siblings are declared as `= intrinsic`: there is no
 * body to inline, and the compiler evaluates them itself. So they are left to
 * the checker to fold, like any other type it can work out.
 */
const isIntrinsic = (declaration: ts.TypeAliasDeclaration) =>
  declaration.type.kind === ts.SyntaxKind.IntrinsicKeyword;

/** Register a user alias as a `const` (or an async arrow, when generic) of the current test. */
export function registerAlias(
  inputOrContext: EmitInputOrContext,
  symbol: ts.Symbol,
  decl: ts.TypeAliasDeclaration,
): Alias {
  ensureEmitContext(inputOrContext);
  const existing = inputOrContext.state.aliases.get(symbol);
  if (existing) return existing;
  const clashes = inputOrContext.checker.resolveName(
    decl.name.text,
    decl,
    ts.SymbolFlags.Value,
    false,
  );
  const a: Alias = {
    name: clashes ? `${decl.name.text}$` : decl.name.text,
    generic: !!decl.typeParameters?.length,
    code: "",
    line: inputOrContext.lineOf(decl),
  };
  inputOrContext.state.aliases.set(symbol, a);
  const body = expr(inputOrContext, decl.type); // may register further aliases (dependencies first → dependency order)
  // `Fixture<T, I>` keeps its declared type on the const, so the generated code re-checks the DSL's guarantee.
  const fixtureArg =
    ts.isTypeReferenceNode(decl.type) &&
    inputOrContext.dslName(decl.type) === "Fixture"
      ? decl.type.typeArguments?.[0]
      : undefined;
  const fixtureType = fixtureArg ? `: ${fixtureArg.getText()}` : "";
  const params =
    decl.typeParameters
      ?.map((p) => `${p.name.text}: ${p.constraint?.getText() ?? "unknown"}`)
      .join(", ") ?? "";
  a.code = a.generic
    ? `const ${a.name} = async (${params}) => ${body};`
    : `const ${a.name}${fixtureType} = ${body};`;
  inputOrContext.state.order.push(a);
  return a;
}

export const callee = (
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode,
) =>
  ts.isTypeQueryNode(node)
    ? entityName(inputOrContext, node.exprName)
    : expr(inputOrContext, node);

export const tupleArgs = (
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode,
) =>
  ts.isTupleTypeNode(node)
    ? node.elements
        .map((e) => expr(inputOrContext, ts.isNamedTupleMember(e) ? e.type : e))
        .join(", ")
    : asEmitContext(inputOrContext).unsupported(node);

/** The string content of a string-literal type node (or of whatever the checker folds it to). */
export const literalText = (
  inputOrContextOrChecker: EmitInputOrContext | ts.TypeChecker,
  node: ts.TypeNode,
) => {
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
    return node.literal.text;
  const checker = isInputOrContext(inputOrContextOrChecker, "program")
    ? asEmitContext(inputOrContextOrChecker).checker
    : inputOrContextOrChecker;
  return checker
    .typeToString(checker.getTypeFromTypeNode(node))
    .replace(/^"|"$/g, "");
};

export const arity = (
  inputOrContextOrUnsupported: EmitInputOrContext | EmitContext["unsupported"],
  node: ts.TypeReferenceNode,
  n: number,
) =>
  (isInputOrContext(inputOrContextOrUnsupported, "program")
    ? asEmitContext(inputOrContextOrUnsupported).unsupported
    : inputOrContextOrUnsupported)(
    node,
    `expects ${n} type argument${n === 1 ? "" : "s"}`,
  );

/** Anything else: if the checker can reduce it to a literal shape, print that. */
export function fold(
  inputOrContext: EmitInputOrContext,
  node: ts.TypeNode,
): string {
  ensureEmitContext(inputOrContext);
  const v = literalOfType(
    inputOrContext,
    inputOrContext.checker.getTypeFromTypeNode(node),
  );
  return v === UNFOLDABLE ? inputOrContext.unsupported(node) : v;
}

export const UNFOLDABLE = Symbol("unfoldable");

/** A type the checker has already reduced, printed as a value literal — or `UNFOLDABLE`. */
export function literalOfType(
  inputOrContext: EmitInputOrContext,
  type: ts.Type,
): string | typeof UNFOLDABLE {
  ensureEmitContext(inputOrContext);
  const { checker } = inputOrContext;

  if (type.flags & ts.TypeFlags.StringLiteral)
    return inputOrContext.quote((type as ts.StringLiteralType).value);

  if (type.flags & ts.TypeFlags.NumberLiteral)
    return String((type as ts.NumberLiteralType).value);

  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const { negative, base10Value } = (type as ts.BigIntLiteralType).value;
    return `${negative ? "-" : ""}${base10Value}n`;
  }

  if (type.flags & ts.TypeFlags.BooleanLiteral)
    return checker.typeToString(type);

  if (type.flags & ts.TypeFlags.Null) return "null";

  if (type.flags & ts.TypeFlags.Undefined) return "undefined";

  if (checker.isTupleType(type)) {
    const items = checker
      .getTypeArguments(type as ts.TypeReference)
      .map((arg) => literalOfType(inputOrContext, arg));
    return items.every(isString) ? `[${items.join(", ")}]` : UNFOLDABLE;
  }

  if (
    type.flags & ts.TypeFlags.Object &&
    !((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Class)
  ) {
    const props: (string | typeof UNFOLDABLE)[] = type
      .getProperties()
      .map((p) => {
        const v = literalOfType(inputOrContext, checker.getTypeOfSymbol(p));
        return v === UNFOLDABLE
          ? UNFOLDABLE
          : `${inputOrContext.propKey(p.getName())}: ${v}`;
      });
    return props.every(isString) ? `{ ${props.join(", ")} }` : UNFOLDABLE;
  }

  return UNFOLDABLE;
}

export const isString = (v: unknown): v is string => typeof v === "string";
