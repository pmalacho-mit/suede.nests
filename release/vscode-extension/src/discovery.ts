import ts from "typescript";

import { isDslModule } from "../../workspace.mts";

import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";

export const hasTests = (text: string) => text.includes("import.meta.vitest");

declare namespace hasTests {
  type ExampleImport = `
import {} from "../namespace-tests/dsl.import.meta.vitest.ts";
... blah blah ...
`;

  export type Simple = Expect<
    Invoke<typeof hasTests, [ExampleImport]>,
    "truthy"
  >;

  export type Negative = Expect<
    Invoke<typeof hasTests, [Uppercase<ExampleImport>]>,
    "falsy"
  >;
}

const createSource = (fileName: string, text: string) =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);

const importsTheDsl = (statement: ts.Statement): statement is ts.ImportDeclaration =>
  ts.isImportDeclaration(statement) &&
  ts.isStringLiteral(statement.moduleSpecifier) &&
  isDslModule(statement.moduleSpecifier.text);

function* boundNames(statement: ts.ImportDeclaration): Generator<string> {
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) yield bindings.name.text;
  else for (const { name } of bindings.elements) yield name.text;
}

const dslBindings = (source: ts.SourceFile): ReadonlySet<string> =>
  new Set(source.statements.filter(importsTheDsl).flatMap((s) => [...boundNames(s)]));

declare namespace dslBindings {
  /**
   * The DSL under other names: what counts is where the type came from, not
   * what it is spelled. A local type of the same name is not the DSL's.
   */
  export type Spellings = `
import type { Expect as Assert } from "namespace-tests/dsl.import.meta.vitest";
import type * as dsl from "./dsl.import.meta.vitest.ts";
import type { Expect as Borrowed } from "./somewhere-else.ts";
type Expect<A, B, C> = { mine: [A, B, C] };
declare namespace renamed {
  export type Aliased = Assert<1, "=", 1>;
  export type Qualified = dsl.Expect<1, "=", 1>;
  export type NotTheirs = Expect<1, "=", 1>;
  export type NotFromUs = Borrowed<1, "=", 1>;
}
`;

  type Parsed = Invoke<typeof createSource, ["probe.ts", Spellings]>;
  type Bound = Invoke<typeof dslBindings, [Parsed]>;

  export type BoundIsLimited = [
    Expect<Bound["size"], "=", 2>,
    Expect<Bound, "includes", "Assert">,
    Expect<Bound, "includes", "dsl">,
    Expect<Bound, "excludes", "Borrowed">,
    Expect<Bound, "excludes", "Expect">,
  ];
}

const stringLiteral = (node: ts.TypeNode | undefined) =>
  node && ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    ? node.literal
    : null;

const displayMember = (config: ts.TypeLiteralNode) => {
  for (const member of config.members)
    if (ts.isPropertySignature(member) && member.name.getText() === "display")
      return stringLiteral(member.type);
  return null;
};

const pageNamedBy = (argument: ts.TypeNode) => {
  const page = stringLiteral(argument);
  if (page?.text.endsWith(".html")) return page;
  return ts.isTypeLiteralNode(argument) ? displayMember(argument) : null;
};

const displayIn = (type: ts.TypeNode | undefined): ts.StringLiteral | null => {
  if (!type) return null;
  if (ts.isTupleTypeNode(type))
    return type.elements.map(displayIn).find(Boolean) ?? null;
  if (!ts.isTypeReferenceNode(type)) return null;
  for (const argument of type.typeArguments ?? []) {
    const page = pageNamedBy(argument) ?? displayIn(argument);
    if (page) return page;
  }
  return null;
};

const firstIdentifier = (name: ts.EntityName): string =>
  ts.isIdentifier(name) ? name.text : firstIdentifier(name.left);

// the printer, not the editor, says whether it can run what the DSL wrote
const isTestType = (
  type: ts.TypeNode | undefined,
  dsl: ReadonlySet<string>,
): boolean => {
  if (!type) return false;
  if (ts.isTupleTypeNode(type))
    return (
      type.elements.length > 0 &&
      type.elements.every((element) => isTestType(element, dsl))
    );
  return ts.isTypeReferenceNode(type) && dsl.has(firstIdentifier(type.typeName));
};

const isExported = (statement: ts.Statement) =>
  ts.canHaveModifiers(statement) &&
  !!ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);

const isTest = (
  statement: ts.Statement,
  dsl: ReadonlySet<string>,
): statement is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(statement) &&
  isExported(statement) &&
  isTestType(statement.type, dsl);

type Range = { line: number; column: number; length: number };

export type DiscoveredTest = Range & {
  name: string;
  alias: string;
  path: string[];
  source: string;
  display: string | null;
  displayAt: Range | null;
};

const rangeOf = (source: ts.SourceFile, node: ts.Node): Range => {
  const start = node.getStart(source);
  const { line, character } = source.getLineAndCharacterOfPosition(start);
  return { line, column: character, length: node.getEnd() - start };
};

const discovered = (
  source: ts.SourceFile,
  statement: ts.TypeAliasDeclaration,
  path: string[],
): DiscoveredTest => {
  const page = displayIn(statement.type);
  return {
    path,
    ...rangeOf(source, statement.name),
    name: [...path, statement.name.text].join(" > "),
    alias: statement.name.text,
    display: page?.text ?? null,
    displayAt: page ? rangeOf(source, page) : null,
    source: statement.getText(source).trim(),
  };
};

type Namespace = { path: string[]; body: ts.ModuleBlock };

// `declare namespace A.B` nests B inside A without a block between them
const namespaceAt = (node: ts.ModuleDeclaration, outer: string[]): Namespace | null => {
  const path = [...outer];
  let current: ts.ModuleBody | ts.ModuleDeclaration | undefined = node;
  while (current && ts.isModuleDeclaration(current) && ts.isIdentifier(current.name)) {
    path.push(current.name.text);
    current = current.body;
  }
  return current && ts.isModuleBlock(current) ? { path, body: current } : null;
};

function* namespacesIn(node: ts.Node, outer: string[] = []): Generator<Namespace> {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  for (const child of children) {
    if (!ts.isModuleDeclaration(child) || !ts.isIdentifier(child.name))
      yield* namespacesIn(child, outer);
    else {
      const namespace = namespaceAt(child, outer);
      if (namespace) yield namespace;
    }
  }
}

export function discover(
  fileName: string,
  text: string,
  root?: string,
): DiscoveredTest[] {
  const source = createSource(fileName, text);
  const dsl = dslBindings(source);
  return [...namespacesIn(source)]
    .filter(({ path }) => !root || path[0] === root)
    .flatMap(({ path, body }) =>
      body.statements
        .filter((statement) => isTest(statement, dsl))
        .map((statement) => discovered(source, statement, path)),
    );
}

declare namespace discover {
  type Suite = `
import type { Expect, Invoke, Skip } from "../namespace-tests/dsl.import.meta.vitest.ts";
declare namespace parseDate {
  export type Iso = Expect<Invoke<typeof parseDate, ["2020-01-01"]>, "truthy">;
  export type Helper = { format: "iso" };
}
declare namespace Tests.elsewhere {
  export type Deep = Skip<Expect<1, "=", 1>>;
}
`;

  type Found = Invoke<typeof discover, ["probe.ts", Suite]>;

  /**
   * A namespace is named for what it covers, and a test's path is where it was
   * written. Only the keys listed are compared, so the rest of each record —
   * its line, its column, its source — is free to change.
   */
  export type Anywhere = Expect<
    Found,
    "matches",
    [
      { name: "parseDate > Iso"; path: ["parseDate"] },
      { name: "Tests > elsewhere > Deep"; path: ["Tests", "elsewhere"] },
    ]
  >;

  /** an exported alias that is not a test is not one: two here, not three */
  export type OnlyTests = Expect<Found["length"], "=", 2>;

  /** the DSL under other names counts; a local type of the same name does not */
  export type ByOrigin = Expect<
    Invoke<typeof discover, ["probe.ts", dslBindings.Spellings]>,
    "matches",
    [{ name: "renamed > Aliased" }, { name: "renamed > Qualified" }]
  >;

  /** a root, when given, is the only place looked at */
  export type UnderARoot = Expect<
    Invoke<typeof discover, ["probe.ts", Suite, "Tests"]>,
    "matches",
    [{ name: "Tests > elsewhere > Deep" }]
  >;
}

declare namespace displayIn {
  type Suite = `
import type { Expect, Invoke, Skip } from "./dsl.import.meta.vitest.ts";
declare namespace histogram {
  export type Visual = Expect<1, "=", 1, "./chart.html">;
  export type Configured = Expect<1, "=", 1, { display: "./page.html"; timeout: 10 }>;
  export type Skipped = Skip<Expect<1, "=", 1, "./skipped.html">>;
  export type Plain = Expect<1, "=", 1>;
}
`;

  /** where the page is named, so a missing one can be marked there */
  export type Located = Expect<
    Invoke<typeof discover, ["probe.ts", Suite]>,
    "matches",
    [
      { alias: "Visual"; displayAt: { line: 3; column: 41; length: 14 } },
      { alias: "Configured"; displayAt: { line: 4; column: 56; length: 13 } },
      { alias: "Skipped"; displayAt: { line: 5; column: 47; length: 16 } },
      { alias: "Plain"; displayAt: null }
    ]
  >;

  /** written as the page, as a config that names one, or under a modifier */
  export type Pages = Expect<
    Invoke<typeof discover, ["probe.ts", Suite]>,
    "matches",
    [
      { alias: "Visual"; display: "./chart.html" },
      { alias: "Configured"; display: "./page.html" },
      { alias: "Skipped"; display: "./skipped.html" },
      { alias: "Plain"; display: null }
    ]
  >;
}
