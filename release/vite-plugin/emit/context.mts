// The state every piece of the printer shares: the checker, the file being
// printed, the warnings collected so far, the imports to inject, and the
// per-test state. Passed explicitly as `cx` so each piece can be built — and
// tested — on its own.
import ts from "typescript";

/**
 * The DSL entry; type references whose declaration lives here are DSL intrinsics.
 *
 * The filename carries `import.meta.vitest` on purpose: Vitest discovers a file
 * with tests by globbing `includeSource` and keeping whatever *contains* that
 * string, so importing the DSL is what makes a module discoverable. Matching on
 * the filename means it works wherever the DSL is installed — vendored beside
 * your code, or in node_modules.
 */
export const DSL_FILE = /dsl\.import\.meta\.vitest\.ts$/;

/** An authoring problem found while printing. Positions are 0-based. */
export type Warning = {
  line: number;
  column: number;
  length: number;
  message: string;
};

export type Imports = Map<string, Set<string>>;

/** One generated line and the 0-based original line it maps to (or null). */
export type Line = { code: string; line: number | null };

/** A user type alias referenced by the current test, printed as a `const` (or an async arrow when generic). */
export type Alias = {
  name: string;
  generic: boolean;
  code: string;
  line: number;
};

/** Per-test state: which aliases the test references, in dependency order. */
export type TestState = {
  aliases: Map<ts.Symbol, Alias>;
  order: Alias[];
  usesTask: boolean;
};

export const freshTestState = (): TestState => ({
  aliases: new Map(),
  order: [],
  usesTask: false,
});

/** The 0-based line a node starts on. */
const lineOf = (source: ts.SourceFile, node: ts.Node) =>
  source.getLineAndCharacterOfPosition(node.getStart()).line;

/** A generated statement anchored to the node it came from. */
const attachLineToCode = (
  source: ts.SourceFile,
  code: string,
  node: ts.Node | null,
) => ({
  code,
  line: node ? lineOf(source, node) : null,
});

const quote = (str: string) => JSON.stringify(str);

const propKey = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);

const getNameIfNodeIsDSLType = (
  checker: ts.TypeChecker,
  node: ts.TypeReferenceNode,
) => {
  const symbol = checker.getSymbolAtLocation(node.typeName);
  const target =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const declaration = target?.declarations?.[0];
  return target &&
    declaration &&
    DSL_FILE.test(declaration.getSourceFile().fileName)
    ? target.getName()
    : null;
};

const unsupported = (
  source: ts.SourceFile,
  warnings: Warning[],
  node: ts.Node,
  why = "is a type, not a value",
) => {
  const { line, character } = source.getLineAndCharacterOfPosition(
    node.getStart(),
  );
  warnings?.push({
    line,
    column: character,
    length: node.getWidth(),
    message: `\`${node.getText()}\` ${why}`,
  });
  return `nt_unsupported(${quote(node.getText())})`;
};

/**
 * An identifier used as a value. If it comes from a *type-only* import, the
 * binding does not exist at runtime, so inject a value import under an
 * aliased name and return that name. Otherwise return the identifier as-is.
 */
const tryImportIdentifierAsValue = (
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  imports: Imports,
  warnings: Warning[],
  identifier: ts.Identifier,
) => {
  const symbol = checker.getSymbolAtLocation(identifier);

  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return identifier.text;

  const declaration = symbol.declarations?.[0];
  const _import =
    declaration && ts.findAncestor(declaration, ts.isImportDeclaration);

  if (!declaration || !_import || !ts.isStringLiteral(_import.moduleSpecifier))
    return identifier.text;

  const typeOnly =
    _import.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    (ts.isImportSpecifier(declaration) && declaration.isTypeOnly);

  if (!typeOnly) return identifier.text;

  const local = `${identifier.text}$`;
  const set = imports.get(_import.moduleSpecifier.text) ?? new Set<string>();
  if (ts.isImportSpecifier(declaration))
    set.add(
      `${(declaration.propertyName ?? declaration.name).text} as ${local}`,
    );
  else if (ts.isImportClause(declaration)) set.add(`default as ${local}`);
  else if (ts.isNamespaceImport(declaration)) set.add(`* as ${local}`);
  else
    return unsupported(
      source,
      warnings,
      identifier,
      "cannot be re-imported as a value",
    );
  imports.set(_import.moduleSpecifier.text, set);
  return local;
};

/** Where generated code imports `ntTest` and `ntCheck` from. */
export const RUNTIME_MODULE = "@namespace-tests/vite-plugin/runtime";

export const createEmitContext = (
  program: ts.Program,
  source: ts.SourceFile,
) => {
  const checker = program.getTypeChecker();
  const quote = (s: string) => JSON.stringify(s);
  const warnings = new Array<Warning>();
  const imports: Imports = new Map();

  return {
    program,
    /** Where generated code imports the runtime helpers from. */
    runtime: RUNTIME_MODULE,
    checker,
    source,
    warnings,
    /** module specifier → import bindings to inject (`"a as a$"`, `"default as d$"`, `"* as ns$"`) */
    imports,
    /** Runtime helpers the generated header must import or declare. */
    used: { fs: false, env: false, task: false },
    /** State of the test currently being printed; replaced by `resetTest()`. */
    state: freshTestState(),
    /** Start a fresh test: no aliases, no task parameter. */
    resetTest() {
      this.state = freshTestState();
      return this.state;
    },
    quote,
    propKey,
    /** The 0-based line a node starts on. */
    lineOf: lineOf.bind(null, source),
    /** A generated statement anchored to the node it came from. */
    statement: attachLineToCode.bind(null, source),
    /** Is this type reference to one of our DSL types? Returns its name or null. */
    dslName: getNameIfNodeIsDSLType.bind(null, checker),
    /** Record an authoring problem and print a call that fails at run time. */
    unsupported: unsupported.bind(null, source, warnings),
    /**
     * An identifier used as a value. If it comes from a *type-only* import, the
     * binding does not exist at runtime, so inject a value import under an
     * aliased name and return that name. Otherwise return the identifier as-is.
     */
    valueName: tryImportIdentifierAsValue.bind(
      null,
      checker,
      source,
      imports,
      warnings,
    ),
  };
};

export type EmitContext = ReturnType<typeof createEmitContext>;

export type EmitInput = {
  program: ts.Program;
  source: ts.SourceFile;
};

export type EmitInputOrContext = EmitInput | EmitContext;

export function ensureEmitContext(
  input: EmitInput | EmitContext,
): asserts input is EmitContext {
  const discriminator: Exclude<keyof EmitContext, keyof EmitInput> = "checker";
  if (discriminator in input) return;
  Object.assign(input, createEmitContext(input.program, input.source));
}

export const asEmitContext = (input: EmitInput | EmitContext) => {
  ensureEmitContext(input);
  return input;
};

/**
 * Narrow "an emit input (or context) — or something else entirely" to the
 * former. `key` must be a key the emit input has and the alternative does not,
 * which the type of `key` enforces at compile time.
 */
export const isInputOrContext = <T,>(
  inputOrContextOrOther: T | EmitInputOrContext,
  key: Exclude<keyof EmitInputOrContext, keyof Exclude<T, EmitInputOrContext>>,
): inputOrContextOrOther is EmitInputOrContext =>
  !!inputOrContextOrOther &&
  typeof inputOrContextOrOther === "object" &&
  key in inputOrContextOrOther;
