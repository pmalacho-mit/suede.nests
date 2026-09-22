// The state the model shares while lowering one file: the checker, the file,
// the warnings so far, and the state of the test being lowered. Passed
// explicitly as `cx` so each stage can be built — and tested — on its own.
import ts from "typescript";

import type { Binding, Expr } from "./ir.mts";

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

/** Where generated code imports `ntCheck` from, unless the plugin says otherwise. */
export const RUNTIME_MODULE = "@namespace-tests/vite-plugin/runtime";

/** An authoring problem found while printing. Positions are 0-based. */
export type Warning = {
  line: number;
  column: number;
  length: number;
  message: string;
};

/** One generated line and the 0-based original line it maps to (or null). */
export type Line = { code: string; line: number | null };

export type EmitInput = { program: ts.Program; source: ts.SourceFile };

/** State of the test being lowered: the aliases it references, in dependency order. */
export type TestState = {
  bindings: Map<ts.Symbol, Binding>;
  order: Binding[];
  /** module specifier → value imports to inject (`a as a$`, `default as d$`, `* as ns$`) */
  imports: Map<string, Set<string>>;
};

const freshTestState = (): TestState => ({
  bindings: new Map(),
  order: [],
  imports: new Map(),
});

export type EmitContext = ReturnType<typeof createEmitContext>;

export const createEmitContext = (
  program: ts.Program,
  source: ts.SourceFile,
  runtime = RUNTIME_MODULE,
) => {
  const checker = program.getTypeChecker();
  const warnings: Warning[] = [];
  /** A node is asked about several times over — is it a test? which DSL type? — so the answer is kept. */
  const targets = new WeakMap<ts.Node, ts.Symbol | undefined>();

  const cx = {
    program,
    checker,
    source,
    warnings,
    /** Where generated code imports the runtime helpers from. */
    runtime,
    /** State of the test currently being lowered; replaced by `resetTest()`. */
    test: freshTestState(),
    resetTest() {
      cx.test = freshTestState();
      return cx.test;
    },
    /** The 0-based line a node starts on. */
    lineOf: (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart()).line,
    /** The symbol a name refers to, through any import alias. */
    target(name: ts.Node): ts.Symbol | undefined {
      if (targets.has(name)) return targets.get(name);
      const symbol = checker.getSymbolAtLocation(name);
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      targets.set(name, target);
      return target;
    },
    /** Is this a reference to one of the DSL's types? Its name, or null. */
    dslName(node: ts.TypeReferenceNode): string | null {
      const target = cx.target(node.typeName);
      const declaration = target?.declarations?.[0];
      return target &&
        declaration &&
        DSL_FILE.test(declaration.getSourceFile().fileName)
        ? target.getName()
        : null;
    },
    /** Record an authoring problem, and stand in a call that fails at run time. */
    unsupported(node: ts.Node, why = "is a type, not a value"): Expr {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      warnings.push({
        line,
        column: character,
        length: node.getWidth(),
        message: `\`${node.getText()}\` ${why}`,
      });
      return { kind: "unsupported", source: node.getText() };
    },
    /**
     * An identifier used as a value. If it comes from a *type-only* import, the
     * binding does not exist at runtime, so inject a value import under an
     * aliased name and return that name. Otherwise return the identifier as-is.
     */
    valueName(identifier: ts.Identifier): string | Expr {
      const symbol = checker.getSymbolAtLocation(identifier);
      if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias))
        return identifier.text;
      const declaration = symbol.declarations?.[0];
      const importDecl =
        declaration && ts.findAncestor(declaration, ts.isImportDeclaration);
      if (
        !declaration ||
        !importDecl ||
        !ts.isStringLiteral(importDecl.moduleSpecifier)
      )
        return identifier.text;
      const typeOnly =
        importDecl.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (ts.isImportSpecifier(declaration) && declaration.isTypeOnly);
      if (!typeOnly) return identifier.text;

      const local = `${identifier.text}$`;
      const binding = ts.isImportSpecifier(declaration)
        ? `${(declaration.propertyName ?? declaration.name).text} as ${local}`
        : ts.isImportClause(declaration)
          ? `default as ${local}`
          : ts.isNamespaceImport(declaration)
            ? `* as ${local}`
            : null;
      if (!binding)
        return cx.unsupported(identifier, "cannot be re-imported as a value");
      const spec = importDecl.moduleSpecifier.text;
      const set = cx.test.imports.get(spec) ?? new Set<string>();
      set.add(binding);
      cx.test.imports.set(spec, set);
      return local;
    },
  };
  return cx;
};
