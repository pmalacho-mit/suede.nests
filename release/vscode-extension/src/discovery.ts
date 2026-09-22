// Finding the tests in a file, without type-checking anything.
//
// A `ts.Program` would give exact answers and cost seconds; parsing one file
// gives the namespace path, the alias names and their lines, which is all the
// Test Explorer needs. Meaning is the library's business, not the editor's.
import ts from "typescript";

import type {
  Call,
  Construct,
  Expect,
  Invoke,
  Table,
} from "../../dsl.import.meta.vitest.ts";

/** Files only count as tests when they import the DSL, which is what Vitest keys on too. */
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

const DSL_MODULE = /(^|\/)dsl\.import\.meta\.vitest(\.ts)?$/;

/** What this file binds the DSL to: `Expect`, `Expect as Assert`, `* as dsl`. */
const dslBindings = (source: ts.SourceFile): ReadonlySet<string> => {
  const bound = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !DSL_MODULE.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) bound.add(bindings.name.text);
    else for (const { name } of bindings.elements) bound.add(name.text);
  }
  return bound;
};

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

/** The name a type reference starts with: `Expect`, or the `dsl` of `dsl.Expect`. */
const head = (name: ts.EntityName): string =>
  ts.isIdentifier(name) ? name.text : head(name.left);

/**
 * Is this the type of a test? It is if it came from the DSL — or a tuple of
 * such, as the DSL's `Test` says. Whether the printer can make a runnable test
 * of it is the printer's to say, and it says so where it was written.
 */
const testType = (
  type: ts.TypeNode | undefined,
  dsl: ReadonlySet<string>,
): boolean => {
  if (!type) return false;
  if (ts.isTupleTypeNode(type))
    return (
      type.elements.length > 0 &&
      type.elements.every((element) => testType(element, dsl))
    );
  return ts.isTypeReferenceNode(type) && dsl.has(head(type.typeName));
};

const discoverable = (
  statement: ts.Statement,
  dsl: ReadonlySet<string>,
): statement is ts.TypeAliasDeclaration =>
  ts.isTypeAliasDeclaration(statement) &&
  (statement.modifiers?.some(
    ({ kind }) => kind === ts.SyntaxKind.ExportKeyword,
  ) ??
    false) &&
  testType(statement.type, dsl);

export type DiscoveredTest = {
  /** What Vitest reports, and what `-t` matches: `Counter > Chainable`. */
  name: string;
  /** The `export type` alias on its own. */
  alias: string;
  /** Namespace segments, as they were written. */
  path: string[];
  /** 0-based line of the alias. */
  line: number;
  /** 0-based column where the alias name starts, and its width. */
  column: number;
  length: number;
  /** The whole `export type … = …;` as it was written. */
  source: string;
};

const discovered = (
  source: ts.SourceFile,
  statement: ts.TypeAliasDeclaration,
  path: string[],
): DiscoveredTest => {
  const { line, character } = source.getLineAndCharacterOfPosition(
    statement.name.getStart(source),
  );
  return {
    path,
    line,
    name: [...path, statement.name.text].join(" > "),
    alias: statement.name.text,
    column: character,
    length: statement.name.text.length,
    source: statement.getText(source).trim(),
  };
};

/**
 * Every test in a file: an exported alias that *is* one, inside any
 * `declare namespace`. A namespace holds tests because of what its aliases are,
 * not because of what it is called, so it can be named after whatever it
 * covers. Pass `root` to look inside that namespace alone.
 */
export function discover(
  fileName: string,
  text: string,
  root?: string,
): DiscoveredTest[] {
  const source = createSource(fileName, text);
  const found: DiscoveredTest[] = [];
  const dsl = dslBindings(source);

  const walk = (node: ts.Node, prefix: string[]): void => {
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      const segs = [...prefix, node.name.text];
      let body = node.body;
      while (
        body &&
        ts.isModuleDeclaration(body) &&
        ts.isIdentifier(body.name)
      ) {
        segs.push(body.name.text);
        body = body.body;
      }

      if (!body || !ts.isModuleBlock(body)) return;
      if (root && segs[0] !== root) return;

      for (const statement of body.statements)
        if (discoverable(statement, dsl))
          found.push(discovered(source, statement, segs));
      return;
    }
    ts.forEachChild(node, (child) => walk(child, prefix));
  };

  ts.forEachChild(source, (child) => walk(child, []));
  return found;
}

/**
 * A test name as something to compare, rather than to show. The separator
 * between namespace segments is the library's to choose, and a name coming back
 * from a run was printed by whichever version of it the workspace has — which
 * need not be the one this extension was built against.
 */
export const nameKey = (name: string) =>
  name
    .split(/\s*[\u203a>]\s*/)
    .map((segment) => segment.trim())
    .join(">");

declare namespace nameKey {
  /** however the separator is spelled, the same test is the same test */
  export type Spellings = Table<
    typeof nameKey,
    [
      [args: ["Counter > Chainable"], expected: "Counter>Chainable"],
      [args: ["Counter \u203a Chainable"], expected: "Counter>Chainable"],
      [args: ["AtTheRoot"], expected: "AtTheRoot"],
    ]
  >;

  /** a table row keeps its index, which is how a row is told from its table */
  export type Rows = Expect<
    Invoke<typeof nameKey, ["encode \u203a Tagged[1]"]>,
    "=",
    "encode>Tagged[1]"
  >;
}

/**
 * A test name as Vitest's `-t` wants it: a regular expression. A name is not
 * one — `Rows[1]` reads as a character class and matches `Rows1`, which is no
 * test at all — so every name is escaped, and the separator is left open so the
 * filter works whichever way the library spells it.
 */
export const testFilter = (name: string) =>
  name
    .split(/\s*[\u203a>]\s*/)
    .map((segment) => segment.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*[\u203a>]\\s*");

declare namespace testFilter {
  type TagToFilter = Invoke<typeof testFilter, ["encode > Tagged[1]"]>;

  /** a table row is a name, not a pattern: its brackets are literal */
  export type Rows = Expect<
    TagToFilter,
    "=",
    "encode\\s*[\u203a>]\\s*Tagged\\[1\\]"
  >;

  /** Test the filter for a name, as the regular expression Vitest makes of it */
  type TestRegExp<Query extends string> = Call<
    Construct<typeof RegExp, [TagToFilter]>,
    "test",
    [Query]
  >;

  /** it matches the name it was built from */
  export type Matches = Expect<TestRegExp<"encode > Tagged[1]">, "truthy">;

  /** and the same name spelled the other way */
  export type EitherSeparator = Expect<
    TestRegExp<"encode \u203a Tagged[1]">,
    "truthy"
  >;

  /** but not what the unescaped name would have matched */
  export type NotTheClass = Expect<TestRegExp<"encode > Tagged1">, "falsy">;
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

  /**
   * The DSL under other names: what counts is where the type came from, not
   * what it is spelled. A local type of the same name is not the DSL's.
   */
  type Spellings = `
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

  export type ByOrigin = Expect<
    Invoke<typeof discover, ["probe.ts", Spellings]>,
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
