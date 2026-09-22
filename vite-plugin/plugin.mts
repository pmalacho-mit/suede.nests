// Vite plugin: appends generated Vitest code to any module containing a
// `declare namespace Tests` block. Only loaded by Vitest; production builds
// never see it.
import ts from "typescript";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";
import { emitTests } from "./emit/index.mts";
import { minimalFor } from "./minimal.mts";
import { encodeMappings } from "./sourcemap.mts";

import type { Plugin, ViteUserConfig } from "vitest/config";
import type { Warning } from "./emit/index.mts";
import type { Segment } from "./sourcemap.mts";
import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";

export type Options = {
  /**
   * Only collect tests written inside this namespace.
   *
   * There is no default, and none is needed: a `declare namespace` holds tests
   * because its exported aliases *are* tests — `Expect`, `Table`, `Throws`,
   * `Given`, or one of those under a modifier — not because of what it is
   * called. So a namespace can be named after whatever it covers:
   *
   * ```ts
   * declare namespace parseDate {
   *   export type Iso = Expect<Invoke<typeof parseDate, ["2020-01-01"]>, "=", …>;
   * }
   * ```
   *
   * Set this when you want the rest of a file's namespaces left alone.
   */
  root?: string;
  /** tsconfig file name, found upward from cwd. Default `"tsconfig.json"`. */
  tsconfig?: string;
  /**
   * Globs discovery skips, matched against each path relative to the project
   * root — the same shape as Vitest's `exclude`. `node_modules` and
   * dot-directories are always skipped, whatever this says.
   *
   * ```ts
   * exclude: ["fixtures/**", "src/generated/**"]
   * ```
   */
  exclude?: string[];
  /**
   * Extra globs to collect tests from, matched by Vitest exactly as its own
   * `include` is. Discovery already finds every file that imports the DSL, so
   * this is for anything it would miss — or for naming files directly when
   * `scan` is off.
   *
   * ```ts
   * include: ["src/generated/**"]
   * ```
   */
  include?: string[];
  /**
   * Glob for *extracted* tests: a generated test written out to a real file, so
   * it can be run and debugged like any other. They end in `.temp.ts` beside
   * the module they came from, and this is what makes Vitest collect them —
   * your own `include` says nothing about them.
   *
   * Default `"**\/*.temp.ts"`. Pass `false` to leave them out, and add
   * `*.temp.ts` to your `.gitignore`: they are scratch files.
   */
  extracted?: string | false;
  /** Discover test files by scanning cwd. Default `true`. */
  scan?: boolean;
  /** Where diagnostics.json is written. Default `".namespace-tests"`. */
  outDir?: string;
  /**
   * Absolute path of the `runtime` module generated code imports `ntCheck`
   * from. Defaults to this plugin's own sibling when it is running from source
   * — as it does when vendored — and to the package specifier
   * `@namespace-tests/vite-plugin/runtime` when installed as a package.
   */
  runtimeFile?: string;
  /**
   * Also discover tests inside this plugin's own folder.
   *
   * The library ships with tests of its own, written in its own DSL, and they
   * are skipped by default so that vendoring the source does not add them to
   * your suite. This repository is the one place they should run.
   */
  scanSelf?: boolean;
  /**
   * Modules that must **not** be isolated per test, as glob patterns matched
   * against each module's path relative to the project root — the same shape as
   * Vitest's own `include`:
   *
   * ```ts
   * noIsolateModuleImport: ["src/db/**", "src/registry.ts"]
   * ```
   *
   * Each generated test carries its own copy of the module under test and, by
   * default, its own copy of that module's first-party imports, so state a test
   * mutates cannot leak into the next one. A module matched here is shared by
   * every test instead — for a connection pool, a registry, or anything else
   * meant to be singular.
   *
   * The patterns name *modules*, not the specifiers that import them, so one
   * entry covers a module however its importers happen to spell the path.
   *
   * Packages are never isolated: Vitest hands them to Node, which has no notion
   * of the query this uses to fork a module.
   */
  noIsolateModuleImport?: string[];
};

/**
 * What Vitest was told to match test names against, as a pattern.
 *
 * `-t` arrives as the string the user typed; a config file may give a RegExp.
 * Either way it is a *pattern*, exactly as Vitest reads it — so `-t "Rows[0]"`
 * is a character class and matches `Rows0`, not `Rows[0]`.
 */
export function testNameFilter(pattern: unknown): RegExp | null {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string" || !pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null; // Vitest will report the bad pattern; we simply do not filter
  }
}

declare namespace Tests.testNameFilter {
  /** the string `-t` hands over becomes the pattern Vitest matches with */
  export type FromString = Expect<
    Invoke<typeof testNameFilter, [pattern: "Counter"]>,
    "satisfies",
    typeof matchesCounter
  >;

  /** nothing to filter by is not a filter */
  export type Absent = Expect<
    Invoke<typeof testNameFilter, [undefined]>,
    "=",
    null
  >;

  /** it is a pattern, not a literal — `[0]` is a character class, as in Vitest */
  export type Pattern = Expect<
    Invoke<typeof testNameFilter, [pattern: "Rows[0]"]>,
    "satisfies",
    typeof readsAsPattern
  >;

  /** a pattern that will not compile filters nothing, rather than throwing */
  export type Invalid = Expect<
    Invoke<typeof testNameFilter, [pattern: "("]>,
    "=",
    null
  >;
}

const matchesCounter = (filter: RegExp | null) =>
  !!filter?.test("Counter > Chainable");

const readsAsPattern = (filter: RegExp | null) =>
  !!filter?.test("add > Rows0") && !filter.test("add > Rows[0]");

/** Vitest's own default, spelled out for a project that never set `include`. */
const DEFAULT_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];

export default function namespaceTests({
  root,
  tsconfig = "tsconfig.json",
  exclude = ["scratch"],
  include = [],
  extracted = "**/*.temp.ts",
  scan: doScan = true,
  outDir = ".namespace-tests",
  runtimeFile,
  scanSelf = false,
  noIsolateModuleImport = [],
}: Options = {}): Plugin {
  // line-anchored: skips mentions in comments. Whether a namespace holds tests
  // is settled by the printer, which looks at what its aliases are.
  const marker = new RegExp(
    `^\\s*declare\\s+namespace\\s+${root ?? "\\w"}`,
    "m",
  );
  const cwd = process.cwd();
  /** file (relative) → warnings, written to outDir/diagnostics.json */
  const diagnostics: Record<string, Warning[]> = {};

  // ── one LanguageService per plugin instance; files are re-read only when Vite reports a change ──
  const cfgPath = ts.findConfigFile(cwd, ts.sys.fileExists, tsconfig);
  if (!cfgPath)
    throw new Error(`namespace-tests: cannot find ${tsconfig} from ${cwd}`);
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(cfgPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(cfgPath),
  );
  const roots = new Set<string>(parsed.fileNames);
  /** file → version (bumped by watchChange) */
  const versions = new Map<string, number>();
  /** file → snapshot for a version */
  const snapshots = new Map<
    string,
    { version: number; snapshot: ts.IScriptSnapshot }
  >();
  const snapshot = (f: string): ts.IScriptSnapshot | undefined => {
    const v = versions.get(f) ?? 0;
    const cached = snapshots.get(f);
    if (cached && cached.version === v) return cached.snapshot;
    if (!fs.existsSync(f)) return undefined;
    const snap = ts.ScriptSnapshot.fromString(fs.readFileSync(f, "utf8"));
    snapshots.set(f, { version: v, snapshot: snap });
    return snap;
  };
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...roots],
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: snapshot,
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    ...(ts.sys.realpath ? { realpath: ts.sys.realpath } : {}),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  // This library ships with tests of its own, written in its own DSL. They are
  // ours to run, not yours: discovery skips the folder this plugin lives in, so
  // vendoring the source does not add our tests to your suite.
  const self = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  const relative = (file: string) =>
    path.relative(cwd, file).split(path.sep).join("/");
  const excluded = picomatch(exclude, { dot: true });
  // `src/fixtures/**` should stop the walk at `src/fixtures`, not only reject
  // the files under it
  const excludedDir = picomatch(
    exclude.map((pattern) => pattern.replace(/\/\*\*(\/\*)?$/, "")),
    { dot: true },
  );

  /** Files under `dir` that contain a test namespace. */
  const scan = (dir: string, acc: string[] = []): string[] => {
    if (!scanSelf && path.resolve(dir) === self) return acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!excludedDir(relative(p))) scan(p, acc);
      } else if (
        /\.[cm]?tsx?$/.test(e.name) &&
        !e.name.endsWith(".d.ts") &&
        !excluded(relative(p)) &&
        marker.test(fs.readFileSync(p, "utf8"))
      )
        acc.push(p);
    }
    return acc;
  };
  /** The runtime, as the file being transformed would import it. */
  const own = fileURLToPath(new URL("./runtime.mts", import.meta.url));
  const packaged = own.includes(`${path.sep}node_modules${path.sep}`);
  const file = runtimeFile ?? (packaged ? null : own);
  const runtimeFor = (id: string) => {
    if (!file) return undefined; // installed as a package: import it by name
    const rel = path.relative(path.dirname(id), file).split(path.sep).join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  // ── generated test modules ────────────────────────────────────────────
  // Each test becomes its own module: the part of the source it needs, plus one
  // `test(…)`. They are never written to disk — the ids resolve here.

  /** virtual test module id → the test it runs. */
  const generated = new Map<string, { source: string; test: string }>();

  /** `-t` from the command line: generate only the tests that will run. */
  let only: RegExp | null = null;

  const FORK = "namespace-test";
  const SUFFIX = ".namespace.test.ts";

  /** A filesystem-safe id for one test, beside the module it came from. */
  const idFor = (source: string, name: string) =>
    path.join(
      path.dirname(source),
      `${path.basename(source).replace(/\.[cm]?tsx?$/, "")}.${name.replace(/[^\w[\]-]+/g, "_")}${SUFFIX}`,
    );

  /** The fork a module id belongs to, if any. */
  const forkOf = (id: string) => {
    const [file = "", query = ""] = id.split("?");
    const tag = new URLSearchParams(query).get(FORK);
    return tag ? { file, tag } : null;
  };

  /**
   * Give a module's own imports the fork's tag, so each test gets its own
   * instance of everything first-party that its subject reaches — unless the
   * specifier is listed in `noIsolateModuleImport`.
   */
  // picomatch is what Vitest matches its own `include` / `exclude` with, so a
  // pattern means here exactly what it means there
  const shared = picomatch(noIsolateModuleImport);

  /** Is this module one the tests are meant to share? */
  const isShared = (file: string) => {
    const rel = path.relative(cwd, file).split(path.sep).join("/");
    return shared(rel);
  };

  /**
   * Give a module's own imports the fork's tag. The specifiers are found in the
   * parsed module, never by matching text: a string that merely *looks* like an
   * import — a snippet of source held in a constant, say — must be left alone.
   */
  function fork(
    parse: (code: string) => unknown,
    code: string,
    tag: string,
  ): string {
    const edits: { start: number; end: number; text: string }[] = [];
    const tagged = (node: unknown) => {
      const literal = node as {
        type?: string;
        value?: unknown;
        start?: number;
        end?: number;
      };
      if (literal?.type !== "Literal" || typeof literal.value !== "string")
        return;
      const spec = literal.value;
      if (!spec.startsWith(".")) return;
      if (literal.start === undefined || literal.end === undefined) return;
      edits.push({
        start: literal.start,
        end: literal.end,
        text: JSON.stringify(
          `${spec}${spec.includes("?") ? "&" : "?"}${FORK}=${tag}`,
        ),
      });
    };

    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return void node.forEach(walk);
      const n = node as { type?: string; source?: unknown };
      if (
        n.type === "ImportDeclaration" ||
        n.type === "ExportNamedDeclaration" ||
        n.type === "ExportAllDeclaration" ||
        n.type === "ImportExpression"
      )
        tagged(n.source);
      for (const value of Object.values(node)) walk(value);
    };

    try {
      walk(parse(code));
    } catch {
      return code; // not parseable here; leave it to the rest of the pipeline
    }
    let out = code;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
  }

  /** The program the plugin already built, if it holds `file`. */
  const sourceFor = (file: string) => {
    const program = service.getProgram();
    const source = program?.getSourceFile(file);
    return program && source ? { input: { program, source } } : null;
  };

  const writeDiagnostics = () => {
    fs.mkdirSync(path.join(cwd, outDir), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, outDir, "diagnostics.json"),
      JSON.stringify(diagnostics, null, 2),
    );
  };

  return {
    name: "namespace-tests",
    enforce: "pre", // see the original TypeScript before vite:esbuild/oxc strips the namespaces
    config(userConfig: ViteUserConfig) {
      // Vitest finds a module with tests by globbing `includeSource` and keeping
      // whatever contains `import.meta.vitest` — which every file importing the
      // DSL does, since the DSL's own filename carries the marker.
      const files = doScan ? scan(cwd).map((f) => path.relative(cwd, f)) : [];
      const userInclude = userConfig.test?.include;
      const collectsNothing = Array.isArray(userInclude) && !userInclude.length;
      const cfg: ViteUserConfig = {
        test: {
          includeSource: [...files, ...include],
          includeTaskLocation: true,
          // an extracted test is an ordinary test file, but one that no project's
          // `include` is written to catch
          // Vite concatenates what a plugin returns onto what the user wrote,
          // so this adds to their `include` rather than replacing it — but a
          // project that never set one would lose Vitest's default, which is
          // why that is spelled out here. An `include: []` is left alone: it
          // says to collect nothing, and that includes these.
          ...(extracted && !collectsNothing
            ? {
                include: userInclude
                  ? [extracted]
                  : [...DEFAULT_INCLUDE, extracted],
              }
            : {}),
        },
      };
      return cfg;
    },

    configResolved(config) {
      // `-t` arrives as the string the user typed, or as a RegExp when it came
      // from a config file. Vitest reads either as a pattern, so we do too.
      const pattern = (config as { test?: { testNamePattern?: unknown } }).test
        ?.testNamePattern;
      only = testNameFilter(pattern);
    },

    resolveId(id, importer) {
      if (generated.has(id)) return id;
      const forked = forkOf(id);
      if (!forked) return null;
      // Resolve the module normally, then key it by the fork it belongs to.
      // `lang.<ext>` is Vite's convention for telling the pipeline how to parse
      // an id whose query hides its extension — without it, a forked `.ts` file
      // is handed to the JavaScript parser.
      return this.resolve(forked.file, importer, { skipSelf: true }).then(
        (resolved) => {
          if (!resolved) return null;
          const file = resolved.id.split("?")[0] ?? resolved.id;
          // a module the tests share keeps its own id, so every fork of every
          // test resolves to the one instance
          if (isShared(file)) return resolved.id;
          return `${resolved.id}?${FORK}=${forked.tag}&lang${path.extname(file)}`;
        },
      );
    },

    load(id) {
      const entry = generated.get(id);
      if (!entry) return null;
      // the whole point: one test, and only the code it needs to run
      return fork(
        (code) => this.parse(code),
        minimalFor(entry.source, entry.test, {
          root,
          tsconfig,
          ...(runtimeFor(id) ? { runtime: runtimeFor(id)! } : {}),
          // the service already holds this file; building a second program for
          // it would type-check everything it imports all over again
          ...(sourceFor(entry.source) ?? {}),
        }),
        path.basename(id, SUFFIX),
      );
    },
    watchChange(id) {
      versions.set(id, (versions.get(id) ?? 0) + 1);
      for (const [generatedId, entry] of generated)
        if (entry.source === id) generated.delete(generatedId);
    },
    transform(code, rawId) {
      const id = rawId.split("?")[0] ?? rawId;
      // a forked module: hand its own imports the same tag, so the fork is deep
      const forked = forkOf(rawId);
      if (forked)
        return {
          code: fork((c) => this.parse(c), code, forked.tag),
          map: null,
        };

      if (!/\.[cm]?tsx?$/.test(id) || !marker.test(code)) return null;
      roots.add(id);
      // Vite hands us the current content; make sure the service sees the same text.
      const current = snapshots.get(id);
      if (
        !current ||
        current.snapshot.getText(0, current.snapshot.getLength()) !== code
      ) {
        const v = (versions.get(id) ?? 0) + 1;
        versions.set(id, v);
        snapshots.set(id, {
          version: v,
          snapshot: ts.ScriptSnapshot.fromString(code),
        });
      }
      const program = service.getProgram();
      const sf = program?.getSourceFile(id);
      if (!program || !sf) return null;
      const emitted = emitTests({ program, source: sf }, root, runtimeFor(id));
      const { warnings, tests } = emitted;
      const rel = path.relative(cwd, id);
      diagnostics[rel] = warnings;
      writeDiagnostics();
      for (const w of warnings)
        this.warn(`${rel}:${w.line + 1}:${w.column + 1} ${w.message}`);
      if (!tests.length) return null;

      // Register one module per test, then append the collector that pulls them
      // in. `import.meta.vitest` is Vitest's own answer to "is this file the one
      // being collected", so a module that is merely imported adds nothing.
      const filter = only;
      const wanted = filter ? tests.filter((t) => filter.test(t.name)) : tests;
      const imports = wanted.map((t) => {
        const generatedId = idFor(id, t.name);
        generated.set(generatedId, { source: id, test: t.name });
        return {
          code: `  await import(${JSON.stringify(generatedId)});`,
          line: t.line,
        };
      });
      if (!imports.length) return null;
      const collector = [
        { code: ``, line: null },
        {
          code: `// ───────── generated by namespace-tests; not part of your build ─────────`,
          line: null,
        },
        { code: `if (import.meta.vitest) {`, line: null },
        ...imports,
        { code: `}`, line: null },
        { code: ``, line: null },
      ];

      // Each import is anchored to the `export type` it runs, so Vitest reports
      // the test at the line it was written on.
      const origLines = code.split("\n").length;
      const lines: Segment[][] = Array.from({ length: origLines }, (_, l) => [
        [0, 0, l, 0],
      ]);
      for (const l of collector)
        lines.push(l.line === null ? [] : [[2, 0, l.line, 0]]);
      const map = {
        version: 3,
        file: id,
        sources: [id],
        sourcesContent: [code],
        names: [],
        mappings: encodeMappings(lines),
      };
      return {
        code: `${code}\n${collector.map((l) => l.code).join("\n")}`,
        map,
      };
    },
  };
}
