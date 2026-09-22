#!/usr/bin/env node
// One test as a standalone file — the thing the plugin serves from memory and
// the editor extracts to disk, so a user can run, debug and tweak it locally.
//
//   nt-minimal examples/counter.ts Reset
//
// 1. Print the file's tests, and pick the one (or the table rows) asked for.
// 2. Keep only the top-level statements that test reaches, without their
//    `export` keywords, and drop the `declare namespace` blocks.
// 3. Put the preamble that test needs in front, and the test after.
import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import { cacheKey, read, write } from "./cache.mts";
import {
  allNeeds,
  emitTests,
  headerLines,
  namespaces,
  RUNTIME_MODULE,
} from "./emit/index.mts";

import type { Emitted, EmitInput } from "./emit/index.mts";

import type {
  Expect,
  Invoke,
  Table,
  Throws,
} from "../dsl.import.meta.vitest.ts";
import type { minimalForFixture } from "../_internal/harness.mts";

/** Parsed tsconfigs, reused across calls. */
const configs = new Map<string, ts.ParsedCommandLine>();

// One program for every file we are asked about, grown as needed. Keeping a
// program per file instead would hold one whole compiler per file in memory.
const roots = new Set<string>();
let program: ts.Program | undefined;

function programFor(abs: string, parsed: ts.ParsedCommandLine): ts.Program {
  if (program && roots.has(abs)) return program;
  if (!roots.size) for (const f of parsed.fileNames) roots.add(f);
  roots.add(abs);
  program = ts.createProgram([...roots], parsed.options, undefined, program);
  return program;
}

/** The tsconfig as TypeScript reads it, parsed once per config path. */
function configFor(tsconfig: string): ts.ParsedCommandLine {
  const cfgPath = ts.findConfigFile(".", ts.sys.fileExists, tsconfig);
  if (!cfgPath) throw new Error(`cannot find ${tsconfig}`);
  let parsed = configs.get(cfgPath);
  if (!parsed) {
    parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(cfgPath, ts.sys.readFile).config,
      ts.sys,
      path.dirname(cfgPath),
    );
    configs.set(cfgPath, parsed);
  }
  return parsed;
}

/**
 * Printing a file yields every test in it, so it is done once per source file
 * rather than once per test — and the plugin, which prints a file as Vite
 * transforms it, goes through here too, so serving that file's tests prints
 * nothing again. The compiler hands out a new `SourceFile` when a file's text
 * changes, so keying on the object is keying on the text.
 */
const printed = new WeakMap<ts.SourceFile, Map<string, Emitted>>();

export function emittedFor(
  input: EmitInput,
  root?: string,
  runtime?: string,
): Emitted {
  const key = `${root ?? ""}\0${runtime ?? ""}`;
  const byOptions = printed.get(input.source) ?? new Map<string, Emitted>();
  printed.set(input.source, byOptions);
  let emitted = byOptions.get(key);
  if (!emitted) byOptions.set(key, (emitted = emitTests(input, root, runtime)));
  return emitted;
}

/**
 * A test name as something to compare, rather than to print: the separator
 * between namespace segments is whatever the printer happened to join with, and
 * a name arriving from elsewhere — a command line, an editor built against an
 * older version — may spell it the other way.
 */
export const testNameKey = (name: string) =>
  name
    .split(/\s*[\u203a>]\s*/)
    .map((segment) => segment.trim())
    .join(">");

/**
 * The `export type <alias>` a test came from, found by the namespace it was
 * written in: one name can appear under several namespaces in the same file,
 * as `SpecExample` does under both `encodeMappings` and `decodeMappings`.
 */
function aliasOf(
  sf: ts.SourceFile,
  alias: string,
  path: string[],
): ts.TypeAliasDeclaration | undefined {
  let fallback: ts.TypeAliasDeclaration | undefined;
  for (const { segs, body } of namespaces(sf))
    for (const statement of body.statements) {
      if (
        !ts.isTypeAliasDeclaration(statement) ||
        statement.name.text !== alias
      )
        continue;
      if (segs.join(" > ") === path.join(" > ")) return statement;
      fallback ??= statement;
    }
  return fallback;
}

/**
 * The top-level statements a test reaches, by following every identifier it
 * names to what declares it, and then following that declaration's identifiers
 * in turn. Type aliases inside the test namespace are followed through rather
 * than kept: they are inlined into the generated test, not part of the module.
 */
function reachable(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  from: ts.TypeAliasDeclaration,
): Set<ts.Statement> {
  const keep = new Set<ts.Statement>();
  const seen = new Set<ts.Node>();
  const queue: ts.Node[] = [from.type];

  // A test namespace often takes the name of what it tests — `declare namespace
  // decodeMappings` beside `function decodeMappings`. Inside the
  // namespace that name resolves to the namespace, so the symbol alone would
  // lose the function. Falling back to the name finds it.
  const byName = new Map<string, ts.Statement>();
  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    )
      byName.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          byName.set(declaration.name.text, statement);
  }

  // Only an identifier spelled like something the file declares — at the top
  // level or inside a namespace — can resolve to a statement worth keeping, so
  // the checker is asked about those alone, not about every property name.
  const declared = new Set<string>();
  const collect = (block: ts.SourceFile | ts.ModuleBlock) => {
    for (const statement of block.statements) {
      if (ts.isVariableStatement(statement))
        for (const d of statement.declarationList.declarations)
          if (ts.isIdentifier(d.name)) declared.add(d.name.text);
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.name) declared.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          declared.add(clause.namedBindings.name.text);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const e of clause.namedBindings.elements)
            declared.add(e.name.text);
      }
      const name = (statement as { name?: ts.Node }).name;
      if (name && ts.isIdentifier(name)) declared.add(name.text);
    }
  };
  collect(sf);
  for (const { body } of namespaces(sf)) collect(body);

  /** The statement of `sf` a declaration belongs to, if any. */
  const statementOf = (node: ts.Node): ts.Statement | undefined => {
    let current: ts.Node = node;
    while (current.parent && current.parent !== sf) current = current.parent;
    return current.parent === sf ? (current as ts.Statement) : undefined;
  };

  while (queue.length) {
    const node = queue.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const take = (statement: ts.Statement | undefined) => {
      if (!statement || keep.has(statement)) return;
      keep.add(statement);
      queue.push(statement);
    };

    const visit = (child: ts.Node): void => {
      if (ts.isIdentifier(child) && declared.has(child.text)) {
        let resolved = false;
        for (const declaration of checker.getSymbolAtLocation(child)
          ?.declarations ?? []) {
          if (declaration.getSourceFile() !== sf) continue;
          const statement = statementOf(declaration);
          if (!statement) continue;
          // a namespace holds the tests themselves: follow, but do not keep
          if (ts.isModuleDeclaration(statement)) queue.push(declaration);
          else {
            take(statement);
            resolved = true;
          }
        }
        if (!resolved) take(byName.get(child.text));
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  }
  return keep;
}

export function minimalFor(
  file: string,
  testName: string,
  {
    root,
    tsconfig = "tsconfig.json",
    runtime,
    cache = true,
    input,
  }: {
    /** Only reproduce tests written under this namespace. */
    root?: string | undefined;
    tsconfig?: string | undefined;
    runtime?: string | undefined;
    cache?: boolean | undefined;
    /** A program that already holds this file — the plugin has one, so it lends it. */
    input?: EmitInput | undefined;
  } = {},
): string {
  const abs = path.resolve(file);

  const key = cache
    ? cacheKey(fs.readFileSync(abs, "utf8"), testName, root, runtime)
    : null;
  if (key) {
    const hit = read(key);
    if (hit !== null) return hit;
  }

  // ── 1+2: build the candidate source ─────────────────────────────────────
  const program = input?.program ?? programFor(abs, configFor(tsconfig));
  const sf = input?.source ?? program.getSourceFile(abs);
  if (!sf) throw new Error(`cannot load ${file}`);
  const emitted = emittedFor({ program, source: sf }, root, runtime);

  // The tests this name stands for, by full name (`add > Simple`) or by alias
  // (`Simple`). A `Table<…>` alias stands for every one of its rows —
  // `Rows[0]`, `Rows[1]` — so asking for `Rows` reproduces the whole table.
  const wanted = testNameKey(testName);
  const tests = emitted.tests.filter(
    (t) =>
      testNameKey(t.name) === wanted ||
      t.alias === testName ||
      testNameKey(t.name).startsWith(`${wanted}[`),
  );
  const test = tests[0];
  if (!test) throw new Error(`no test named ${testName} in ${file}`);
  const body = tests.map((t) => t.code).join("\n\n");

  // The preamble these tests need, and nothing the rest of the file did — minus
  // the banner, since this file is written to say where it came from itself
  const imports = headerLines(
    allNeeds(tests.map((t) => t.needs)),
    runtime ?? RUNTIME_MODULE,
  ).filter((line) => !line.startsWith("//"));

  // ── 3: keep only what the test reaches ──────────────────────────────────
  const checker = program.getTypeChecker();
  const alias = aliasOf(sf, test.alias, test.path);
  const kept = alias ? reachable(checker, sf, alias) : new Set(sf.statements);

  // `getFullText` carries each statement's own leading comments and spacing, so
  // what is kept reads exactly as it did in the module
  let src = sf.statements
    .filter(
      (statement) =>
        kept.has(statement) &&
        !(
          ts.isImportDeclaration(statement) &&
          statement.importClause?.isTypeOnly
        ),
    )
    .map((statement) => statement.getFullText())
    .join("");
  // strip `export` from declarations (not from `export {…}` lists / `export type`)
  src = src.replace(
    /^export (?=(const|let|var|function|class|interface|type|enum|abstract) )/gm,
    "",
  );
  // a shebang belongs at the top of a file or nowhere; here it is nowhere
  src = src.trimStart().replace(/^#![^\n]*\n/, "");

  // an ordinary Vitest file: imports, the code the test needs, then the test
  const text = [imports.join("\n"), "", src.trim(), "", body, ""].join("\n");

  const minimal = `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
  if (key) write(key, minimal);
  return minimal;
}

declare namespace testNameKey {
  /** however the separator is spelled, the same test is the same test */
  export type Spellings = Table<
    typeof testNameKey,
    [
      [args: ["add > Simple"], expected: "add>Simple"],
      [args: ["add \u203a Simple"], expected: "add>Simple"],
      [args: ["a>b>c"], expected: "a>b>c"],
      [args: ["AtTheRoot"], expected: "AtTheRoot"],
    ]
  >;
}

declare namespace minimalFor {
  /** a name written with the other separator still finds its test */
  export type EitherSeparator = Expect<
    Invoke<
      typeof minimalForFixture,
      [fixture: "counter.ts", test: "Counter \u203a Reset"]
    >,
    "includes",
    "class Counter"
  >;

  type Reset = Invoke<
    typeof minimalForFixture,
    [fixture: "counter.ts", test: "Counter > Reset"]
  >;

  /** the reproduction keeps the class the test exercises */
  export type KeepsSubject = Expect<Reset, "includes", "class Counter">;

  /** and the body of the test, inside an ordinary `test(…)` */
  export type KeepsBody = Expect<
    Reset,
    "includes",
    "expect.soft(Counter$.history).not.toContain(12);"
  >;

  /** which is an ordinary Vitest file: imports first, test last */
  export type LooksNormal = Expect<
    Reset,
    "startsWith",
    'import { test, expect } from "vitest";'
  >;

  /** the namespace blocks are pruned away */
  export type DropsNamespaces = Expect<Reset, "excludes", "declare namespace">;

  /** an unknown test name is an error, not an empty file */
  export type Unknown = Throws<
    Invoke<typeof minimalForFixture, [fixture: "counter.ts", test: "Nope"]>,
    { message: "no test named Nope" }
  >;
}
