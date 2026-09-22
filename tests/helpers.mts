import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import { createEmitContext, emitTests } from "../release/vite-plugin/emit/index.mts";
import plugin from "../release/vite-plugin/plugin.mts";

import type { EncodedSourceMap } from "@jridgewell/trace-mapping";
import type { Emitted } from "../release/vite-plugin/emit/index.mts";
import type { Plugin } from "vitest/config";

export const repoRoot = path.resolve(import.meta.dirname, "..");

let program: ts.Program | undefined;

/**
 * A program over the repo's tsconfig plus `extra` files, reusing the previous program's structure.
 * @param extra Relative to the repo root.
 */
export function programFor(extra: string[] = []): ts.Program {
  const cfgPath = path.join(repoRoot, "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, repoRoot);
  program = ts.createProgram([...parsed.fileNames, ...extra.map((f) => path.join(repoRoot, f))], parsed.options, undefined, program);
  return program;
}

/** @param file Relative to the repo root. */
export function emitFor(file: string): Emitted {
  const prog = programFor([file]);
  const sf = prog.getSourceFile(path.join(repoRoot, file));
  if (!sf) throw new Error(`not in program: ${file}`);
  return emitTests({ program: prog, source: sf });
}

/**
 * Drive the plugin's transform directly, without Vite.
 * @param file Relative to the repo root.
 */
export async function transformFor(file: string): Promise<{ code: string, map: EncodedSourceMap }> {
  const p = plugin({ scan: false, include: [file] });
  const hook = typeof p.transform === "function" ? p.transform : p.transform?.handler;
  if (!hook) throw new Error("plugin has no transform hook");
  const abs = path.join(repoRoot, file);
  const ctx = { warn() {} } as unknown as ThisParameterType<Extract<NonNullable<Plugin["transform"]>, Function>>;
  const result = await hook.call(ctx, fs.readFileSync(abs, "utf8"), abs, undefined);
  if (!result || typeof result === "string" || typeof result.code !== "string" || !result.map || typeof result.map !== "object" || !("mappings" in result.map) || typeof result.map.mappings !== "string") throw new Error(`no transform result for ${file}`);
  return { code: result.code, map: result.map as EncodedSourceMap };
}

// ── unit-test scaffolding for the printer's pieces ─────────────────────────

/** The DSL import every snippet starts with, so `Expect`/`Invoke`/… resolve. */
export const DSL_IMPORT = `import type { Expect, Invoke, Construct, Call, Fixture, Widen, FromFile, Env, Snapshot, Nothing, Given, ExpectGiven, Throws, Table, Skip, Only, Todo, Configure } from "../release/dsl.import.meta.vitest.ts";\n`;

/** Programs are the slow part, so reuse one per distinct snippet. */
const programs = new Map<string, { program: ts.Program; source: ts.SourceFile }>();

const SNIPPET = path.join(import.meta.dirname, "__snippet__.ts");

/**
 * A one-file program over `body` (prefixed with the DSL import), plus a fresh
 * printer context for it. The file is virtual — nothing is written to disk.
 */
export function contextFor(body: string) {
  const code = DSL_IMPORT + body;
  let entry = programs.get(code);
  if (!entry) {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options, true);
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, version, onError, shouldCreate) =>
      name === SNIPPET
        ? ts.createSourceFile(SNIPPET, code, ts.ScriptTarget.ES2022, true)
        : getSourceFile.call(host, name, version, onError, shouldCreate);
    host.fileExists = (f) => f === SNIPPET || fileExists.call(host, f);
    host.readFile = (f) => (f === SNIPPET ? code : readFile.call(host, f));
    const program = ts.createProgram([SNIPPET], options, host);
    const source = program.getSourceFile(SNIPPET);
    if (!source) throw new Error("snippet did not load");
    entry = { program, source };
    programs.set(code, entry);
  }
  return {
    ...entry,
    cx: createEmitContext(entry.program, entry.source),
    /** The declaration of `type <name> = …`, wherever it is in the snippet. */
    alias: (name: string) => aliasIn(entry.source, name),
    /** The right-hand side of `type <name> = …`. */
    type: (name: string) => aliasIn(entry.source, name).type,
  };
}

function aliasIn(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name)
      found = node;
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (!found) throw new Error(`no type alias named ${name} in the snippet`);
  return found;
}
