// The docs model of a whole project: every file's tests (model.mts), and what
// only the whole program knows. Who calls each function, from where, and
// whether from code, a test or a harness; which harness modules the tests speak
// through; which modules they replace; and how the last run went.
import ts from "@typescript/typescript6";
import fs from "node:fs";
import path from "node:path";

import { lowerTests } from "../vite-plugin/emit/index.mts";
import {
  docTextOf,
  holderOf,
  isExported,
  isFunctionLike,
  statementOf,
  topLevelDeclarations,
} from "../vite-plugin/emit/declarations.mts";
import { configFor } from "../vite-plugin/minimal.mts";
import { DERIVED } from "../vite-plugin/cache.mts";
import { relativeTo } from "../vite-plugin/paths.mts";
import {
  LIBRARY,
  testModuleFinder,
  testNamespaceMarker,
} from "../vite-plugin/discovery.mts";
import {
  claimId,
  fileDocs,
  lineOf,
  MODEL_VERSION,
  subjectId,
} from "./model.mts";
import { resolved } from "./lookup.mts";

import type { ResultRecord } from "../vite-plugin/reporter.mts";
import type { FileDocs } from "./model.mts";

export type Reference = {
  file: string;
  line: number;
  role: "production" | "test" | "harness";
  /** The top-level declaration the reference is inside, for a production one. */
  caller: string | null;
  /** The call it is the callee of, as written, cut short. */
  call: string | null;
};

export type HarnessDoc = {
  file: string;
  /** The comment the module opens with: what it stands in for. */
  purpose: string | null;
  exports: { name: string; doc: string | null; claims: number }[];
};

export type BoundaryDoc = {
  /** The module replaced, from the project root. */
  module: string;
  replacements: string[];
  claims: number;
  from: string[];
};

export type ProjectDocs = {
  version: number;
  root: string;
  files: FileDocs[];
  /** By `subjectId(file, name)`. */
  references: Record<string, Reference[]>;
  /** Top-level functions in files with tests that have none of their own. */
  unclaimed: {
    file: string;
    name: string;
    line: number;
    exported: boolean;
    callers: number;
  }[];
  harnesses: HarnessDoc[];
  boundaries: BoundaryDoc[];
  /** Every `{@link …}` in a file with tests: a claim cited from prose, and whether it resolves. */
  links: {
    file: string;
    line: number;
    target: string;
    resolved: boolean;
    from: string | null;
  }[];
  /** By `claimId(file, name)`, from the last run's `.derived/results.json`. */
  results: Record<string, ResultRecord["state"]>;
};

export type ProjectOptions = {
  root?: string;
  tsconfig?: string;
  /** Globs discovery skips, relative to `root`, as the plugin's `exclude` is. */
  exclude?: string[];
  /** The files to read, in place of discovering them. */
  files?: string[];
  /** Read the library's own tests too: a project that vendors it does not want them. */
  self?: boolean;
  /** Where the library sits in this tree, when it is not where this module runs from. */
  library?: string;
  /** A program that already holds the files, lent instead of building one. */
  program?: ts.Program;
  /** Where references are looked for: every file of the program (the default), or only `files`. */
  scope?: "program" | "files";
  /** Only what each file's tests say: no references, harnesses, boundaries, links or results. */
  filesOnly?: boolean;
};

const isAmbientNamespace = (node: ts.Node) =>
  ts.isModuleDeclaration(node) &&
  !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

// the top-level declaration a node is inside, by name
const callerOf = (source: ts.SourceFile, node: ts.Node): string | null => {
  const top = statementOf(source, node);
  if (
    top &&
    (ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) &&
    top.name
  )
    return top.name.text;
  if (top && ts.isVariableStatement(top)) {
    const d = top.declarationList.declarations[0];
    return d && ts.isIdentifier(d.name) ? d.name.text : null;
  }
  return "(module)";
};

const readResults = (root: string): ProjectDocs["results"] => {
  const file = path.join(DERIVED, "results.json");
  if (!fs.existsSync(file)) return {};
  try {
    const { results } = JSON.parse(fs.readFileSync(file, "utf8")) as {
      results: ResultRecord[];
    };
    return Object.fromEntries(
      results.map((r) => [
        claimId(relativeTo(root, path.resolve(root, r.file)), r.name),
        r.state,
      ]),
    );
  } catch {
    return {};
  }
};

const openingComment = (source: ts.SourceFile): string | null => {
  const text = source.getFullText();
  const body = (ts.getLeadingCommentRanges(text, 0) ?? [])
    .map((r) =>
      text
        .slice(r.pos, r.end)
        .replace(/^\/\/ ?/gm, "")
        .replace(/^\/\*+|\*+\/$/g, "")
        .replace(/^\s*\* ?/gm, ""),
    )
    .join("\n")
    .replace(/^\/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return body || null;
};

type Read = { file: string; source: ts.SourceFile; docs: FileDocs };

// harness modules and replaced modules, resolved from the test that names them
function usesOf(program: ts.Program, root: string, read: Read[]) {
  const resolutions = new Map<string, string | null>();
  const resolve = (importer: string, specifier: string) => {
    const key = `${importer}\0${specifier}`;
    if (!resolutions.has(key))
      resolutions.set(
        key,
        ts.resolveModuleName(
          specifier,
          importer,
          program.getCompilerOptions(),
          ts.sys,
        ).resolvedModule?.resolvedFileName ?? null,
      );
    return resolutions.get(key)!;
  };
  const harnessUse = new Map<string, Map<string, number>>();
  const boundaries = new Map<string, BoundaryDoc>();
  for (const { source, docs } of read)
    for (const c of docs.claims) {
      for (const h of c.uses.harness) {
        const target = resolve(source.fileName, h.from);
        if (!target) continue;
        const names =
          harnessUse.get(relativeTo(root, target)) ?? new Map<string, number>();
        names.set(h.name, (names.get(h.name) ?? 0) + 1);
        harnessUse.set(relativeTo(root, target), names);
      }
      for (const m of c.uses.mocks) {
        const target = resolve(source.fileName, m.path);
        const module = target ? relativeTo(root, target) : m.path;
        const b = boundaries.get(module) ?? {
          module,
          replacements: [],
          claims: 0,
          from: [],
        };
        b.claims++;
        if (m.with && !b.replacements.includes(m.with))
          b.replacements.push(m.with);
        if (!b.from.includes(docs.file)) b.from.push(docs.file);
        boundaries.set(module, b);
      }
    }
  return {
    harnessUse,
    boundaries: [...boundaries.values()].sort((a, b) => b.claims - a.claims),
  };
}

type Candidate = {
  key: string;
  file: string;
  name: string;
  declaration: ts.Declaration;
};

// every reference to a candidate, from every file walked
function referencesTo(
  checker: ts.TypeChecker,
  root: string,
  walked: readonly ts.SourceFile[],
  candidates: Candidate[],
  harnessFiles: Set<string>,
): ProjectDocs["references"] {
  const bySymbol = new Map<ts.Symbol, string>();
  for (const c of candidates) {
    const symbol = checker.getSymbolAtLocation(
      ts.getNameOfDeclaration(c.declaration)!,
    );
    if (symbol) bySymbol.set(symbol, c.key);
  }
  const names = new Set(candidates.map((c) => c.name));
  const references: ProjectDocs["references"] = {};
  for (const source of walked) {
    const file = relativeTo(root, source.fileName);
    // only a name a candidate is called, or a local name one is imported as, is asked about
    const spelled = new Set(names);
    for (const st of source.statements)
      if (
        ts.isImportDeclaration(st) &&
        st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings)
      )
        for (const el of st.importClause.namedBindings.elements)
          if (names.has((el.propertyName ?? el.name).text))
            spelled.add(el.name.text);
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        spelled.has(node.text) &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isImportClause(node.parent) &&
        !ts.isExportSpecifier(node.parent)
      ) {
        const symbol = resolved(checker, checker.getSymbolAtLocation(node));
        const key = symbol && bySymbol.get(symbol);
        if (
          key &&
          !symbol!.declarations?.some(
            (d) => ts.getNameOfDeclaration(d) === node,
          )
        ) {
          const callee =
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name === node
              ? node.parent
              : node;
          const call =
            ts.isCallExpression(callee.parent) &&
            callee.parent.expression === callee
              ? callee.parent.getText().replace(/\s+/g, " ").slice(0, 160)
              : null;
          const role: Reference["role"] = harnessFiles.has(file)
            ? "harness"
            : ts.findAncestor(node, isAmbientNamespace)
              ? "test"
              : "production";
          (references[key] ??= []).push({
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            role,
            caller: role === "production" ? callerOf(source, node) : null,
            call,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return references;
}

// each `{@link …}` once: the same JSDoc is handed back for a declaration and its statement
function linksIn(checker: ts.TypeChecker, read: Read[]): ProjectDocs["links"] {
  const links: ProjectDocs["links"] = [];
  for (const { source, docs } of read) {
    const values = topLevelDeclarations(source);
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJSDocLink(node) ||
          ts.isJSDocLinkCode(node) ||
          ts.isJSDocLinkPlain(node)) &&
        node.name
      ) {
        const owner = callerOf(source, node);
        links.push({
          file: docs.file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          target: node.name.getText(),
          resolved: !!checker.getSymbolAtLocation(node.name),
          from: owner && values.has(owner) ? owner : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    const walk = (node: ts.Node): void => {
      for (const doc of ts.getJSDocCommentsAndTags(node))
        if (!seen.has(doc)) {
          seen.add(doc);
          visit(doc);
        }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return links;
}

const programFor = (root: string, tsconfig: string, files: string[]) => {
  const config = configFor(tsconfig, root);
  return ts.createProgram(
    [...new Set([...config.fileNames, ...files])],
    config.options,
  );
};

/** The docs model of every file with tests under `root`. */
export function projectDocs({
  root = process.cwd(),
  tsconfig = "tsconfig.json",
  exclude = [],
  files,
  self = false,
  library = LIBRARY,
  program: lent,
  scope = "program",
  filesOnly = false,
}: ProjectOptions = {}): ProjectDocs {
  const testFiles = files?.map((f) => path.resolve(root, f)) ?? [
    ...testModuleFinder({
      cwd: root,
      exclude,
      marker: testNamespaceMarker(),
      skip: self ? null : library,
    })(root),
  ];
  const program = lent ?? programFor(root, tsconfig, testFiles);
  const checker = program.getTypeChecker();
  const read: Read[] = testFiles.flatMap((file) => {
    const source = program.getSourceFile(file);
    if (!source) return [];
    const rel = relativeTo(root, file);
    return [
      {
        file: rel,
        source,
        docs: fileDocs(
          { program, source },
          lowerTests({ program, source }).tests,
          rel,
        ),
      },
    ];
  });
  const model: ProjectDocs = {
    version: MODEL_VERSION,
    root,
    files: read.map((r) => r.docs),
    references: {},
    unclaimed: [],
    harnesses: [],
    boundaries: [],
    links: [],
    results: {},
  };
  if (filesOnly) return model;

  const { harnessUse, boundaries } = usesOf(program, root, read);
  const harnessFiles = new Set(harnessUse.keys());

  // every top-level value of a file with tests, so references to the untested are counted too
  const candidates: Candidate[] = read.flatMap(({ file, source }) =>
    [...topLevelDeclarations(source)].map(([name, { declaration }]) => ({
      key: subjectId(file, name),
      file,
      name,
      declaration,
    })),
  );
  const walked =
    scope === "files"
      ? read.map((r) => r.source)
      : program
          .getSourceFiles()
          .filter(
            (s) =>
              !s.isDeclarationFile &&
              !program.isSourceFileFromExternalLibrary(s) &&
              s.fileName.startsWith(root),
          );
  const references = referencesTo(
    checker,
    root,
    walked,
    candidates,
    harnessFiles,
  );

  const claimed = new Set(
    model.files.flatMap((f) =>
      f.subjects.map((s) => subjectId(f.file, s.name)),
    ),
  );
  model.unclaimed = candidates
    .filter(
      (c) =>
        !claimed.has(c.key) &&
        !harnessFiles.has(c.file) &&
        isFunctionLike(c.declaration),
    )
    .map(({ key, file, name, declaration }) => ({
      file,
      name,
      line: lineOf(declaration),
      exported: isExported(holderOf(declaration)),
      callers: (references[key] ?? []).filter((r) => r.role === "production")
        .length,
    }));

  model.harnesses = [...harnessUse].map(([file, names]) => {
    const source = program.getSourceFile(path.resolve(root, file));
    const values = source ? topLevelDeclarations(source) : new Map();
    return {
      file,
      purpose: source ? openingComment(source) : null,
      exports: [...names]
        .map(([name, claims]) => {
          const declaration = values.get(name)?.declaration;
          return {
            name,
            doc: declaration ? docTextOf(declaration) : null,
            claims,
          };
        })
        .sort((a, b) => b.claims - a.claims),
    };
  });
  model.references = references;
  model.boundaries = boundaries;
  model.links = linksIn(checker, read);
  model.results = readResults(root);
  return model;
}
