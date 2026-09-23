#!/usr/bin/env node
// The library's command line: one namespace test, printed as a file.
//
//   cli.mts <file> <test>                  the test, as a standalone Vitest file
//   cli.mts <file> <test> --served         as the plugin serves it, imports tagged
//   cli.mts <file> --collector             the module Vitest is handed for the file
//   cli.mts --clean [dir]                  delete extracted tests and the cache
//
// It sits beside the DSL rather than in `vite-plugin/` because nothing in the
// plugin calls it: it is a front end onto the same printer, for the editor and
// for anyone at a terminal. Anything a run has already printed is answered from
// the cache without loading TypeScript at all, which is the difference between
// 40ms and a second.
import { createHash } from "node:crypto";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { cli, main } from "./vendored/typescript-cli-suede/index.ts";
import {
  cacheDir,
  cacheKey,
  compileCacheDir,
  ensureDerived,
  read,
  write,
} from "./vite-plugin/cache.mts";

import type { Expect, Invoke } from "./dsl.import.meta.vitest.ts";

const DESCRIPTION = [
  "Print a namespace test as a standalone Vitest file.",
  "",
  "  cli.mts <file> <test>             the test, as it would be extracted",
  "  cli.mts <file> <test> --served    as a run serves it, imports tagged per test",
  "  cli.mts <file> --collector        the module Vitest is handed for the file",
  "  cli.mts --clean [dir]             delete extracted tests under dir, and the cache",
].join("\n");

/**
 * What was asked for, read off an argv. Kept apart from acting on it, so the
 * reading can be tested without a process.
 */
const parse = (argv: string[]) => {
  const args = main(argv, DESCRIPTION, [
    cli.flag(
      ["runtime", "r"],
      "How the generated test imports the library's runtime helpers. Must match the plugin's, or nothing is read back from the cache.",
    ),
    cli.flag("root", "Only look inside this namespace."),
    cli.flag(
      "served",
      "Print the test as the plugin serves it: every first-party import tagged, so each test gets its own copy.",
      false,
    ),
    cli.flag(
      "collector",
      "Print the module Vitest is handed for the file, instead of one test.",
      false,
    ),
    cli.flag(
      "clean-extracted",
      "Delete the tests extracted into files under a directory (default: here). One that has been edited since is kept, unless --force.",
      false,
    ),
    cli.flag(
      "clean-cache",
      "Delete what the library has cached: printed tests, and Node's compiled modules.",
      false,
    ),
    cli.flag("clean", "Both of the above.", false),
    cli.flag(
      "force",
      "With --clean-extracted, delete edited extracts too.",
      false,
    ),
  ]);
  return {
    file: args[0],
    test: args[1],
    mode: args.collector ? "collector" : args.served ? "served" : "test",
    root: args.root,
    runtime: args.runtime,
    clean: {
      extracted: args.clean || args["clean-extracted"],
      cache: args.clean || args["clean-cache"],
      force: args.force,
    },
    help: args.help,
  } as const;
};

type Parsed = ReturnType<typeof parse>;

declare namespace parse {
  /** a file and a test: the test, as it would be extracted */
  export type Test = Expect<
    Invoke<typeof parse, [["src/a.ts", "a > B"]]>,
    "matches",
    { file: "src/a.ts"; test: "a > B"; mode: "test" }
  >;

  export type Served = Expect<
    Invoke<typeof parse, [["src/a.ts", "a > B", "--served"]]>,
    "matches",
    { mode: "served" }
  >;

  /** the whole file needs no test to be named */
  export type Collector = Expect<
    Invoke<typeof parse, [["src/a.ts", "--collector"]]>,
    "matches",
    { file: "src/a.ts"; test: undefined; mode: "collector" }
  >;

  /** a flag may come first: a boolean takes nothing from what follows it */
  export type FlagFirst = Expect<
    Invoke<typeof parse, [["--collector", "src/a.ts"]]>,
    "matches",
    { file: "src/a.ts"; mode: "collector" }
  >;

  /** `--clean` is both kinds of cleaning, and neither needs a test named */
  export type Clean = Expect<
    Invoke<typeof parse, [["--clean"]]>,
    "matches",
    { file: undefined; clean: { extracted: true; cache: true; force: false } }
  >;

  /** each kind on its own, and where to look */
  export type CleanOne = Expect<
    Invoke<typeof parse, [["--clean-extracted", "examples"]]>,
    "matches",
    { file: "examples"; clean: { extracted: true; cache: false } }
  >;

  /** a flag's value is its own, not the next positional */
  export type Runtime = Expect<
    Invoke<
      typeof parse,
      [["src/a.ts", "a > B", "--runtime", "../vite-plugin/runtime.mts"]]
    >,
    "matches",
    { test: "a > B"; runtime: "../vite-plugin/runtime.mts" }
  >;
}

// ── cleaning up ──────────────────────────────────────────────────────────

/**
 * What an extracted file says about itself. This reads the header the editor
 * writes — `vscode-extension/src/extract.ts` owns the format, and this is a
 * copy, because a CommonJS extension cannot share an ES module with the
 * library. If the two drifted, an extract would only ever look edited, and be
 * kept: the copy can be wrong in the safe direction only.
 */
const HEADER = /^\/\/ namespace-tests: .+? > "(?:[^"\\]|\\.)*" \[([0-9a-f]+)\]$/;

const fingerprint = (body: string) =>
  createHash("sha256")
    .update(body.replace(/\s*$/, "\n"))
    .digest("hex")
    .slice(0, 12);

/**
 * Whether a file is one the editor extracted, and if so whether it is still
 * what was written: `null` for anything else, however it is named.
 */
export const extractedState = (text: string): "untouched" | "edited" | null => {
  const lines = text.split("\n");
  const hash = HEADER.exec(lines[0] ?? "")?.[1];
  if (!hash) return null;
  const body = lines.slice(lines.indexOf("") + 1).join("\n");
  return fingerprint(body) === hash ? "untouched" : "edited";
};

declare namespace extractedState {
  /** as the editor wrote it — the fingerprint is the editor's own */
  type Written = '// namespace-tests: src/a.ts > "a > B" [5496e55103b9]\n// Yours to run, debug and edit. Delete it when you are done.\n\ntest("x", () => {});\n';

  export type Untouched = Expect<Invoke<typeof extractedState, [Written]>, "=", "untouched">;

  /** worked on since, which is why it is kept */
  export type Edited = Expect<
    Invoke<typeof extractedState, [Invoke<typeof withBody, [Written, 'test("y", () => {});']>]>,
    "=",
    "edited"
  >;

  /** a file that merely shares the name is not ours to delete */
  export type Stranger = Expect<
    Invoke<typeof extractedState, ["// my own scratch file\nconst a = 1;\n"]>,
    "is",
    null
  >;
}

/** Test support: the same extracted file, with another body. */
const withBody = (text: string, body: string) =>
  text.replace(/test\("x", \(\) => \{\}\);/, body);

/** Directories no extract is ever written into. */
const SKIP = new Set(["node_modules", "dist", "out", "coverage"]);

/** Every `.temp.ts` under `dir`, leaving out hidden folders and dependencies. */
function temps(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) temps(at, found);
    } else if (entry.name.endsWith(".temp.ts")) found.push(at);
  }
  return found;
}

/** Delete what the editor extracted under `dir`; keep what has been worked on. */
function cleanExtracted(dir: string, force: boolean): void {
  for (const file of temps(dir)) {
    const shown = path.relative(process.cwd(), file);
    const state = extractedState(fs.readFileSync(file, "utf8"));
    if (state === null) continue;
    if (state === "edited" && !force) {
      console.log(`kept     ${shown} — edited since it was extracted (--force to delete it too)`);
      continue;
    }
    fs.rmSync(file);
    console.log(`deleted  ${shown}`);
  }
}

/** Delete the library's caches. What the editor reads — results, diagnostics — stays. */
function cleanCache(): void {
  for (const dir of [cacheDir, compileCacheDir]) {
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`cleared  ${path.relative(process.cwd(), dir)}`);
  }
}

const tryCacheNodeCompilation = () => {
  ensureDerived();
  if (!process.env.NODE_COMPILE_CACHE)
    module.enableCompileCache?.(compileCacheDir);
};

const nullPrefixed = <T extends string>(str: T) => `\0${str}` as const;

/**
 * The whole file, and a test as served, are filed under names no test can
 * have, so they never land on a test's own entry.
 */
const cacheName = ({ mode, test }: Pick<Parsed, "mode" | "test">) =>
  mode === "collector"
    ? nullPrefixed(mode)
    : mode === "served"
      ? nullPrefixed(`served ${test}`)
      : test!;

const tryRetrieveFromCache = ({ file, mode, test, root, runtime }: Parsed) => {
  if (!file || !fs.existsSync(file)) return { key: null, hit: null };
  const source = fs.readFileSync(path.resolve(file), "utf8");
  const key = cacheKey(source, cacheName({ mode, test }), root, runtime);
  return { key, hit: read(key) };
};

if (cli.entry(import.meta.url)) {
  const parsed = parse(process.argv.slice(2));
  const { file, test, mode, clean, help } = parsed;

  if (clean.extracted || clean.cache) {
    // Node's compile cache is not switched on here: it is written on exit, and
    // would put back the very thing just cleared.
    if (clean.extracted) cleanExtracted(path.resolve(file ?? "."), clean.force);
    if (clean.cache) cleanCache();
    process.exit(0);
  }

  tryCacheNodeCompilation();

  if (!file || (mode !== "collector" && !test)) {
    console.error(help());
    process.exit(2);
  }

  const { hit, key } = tryRetrieveFromCache(parsed);

  if (hit !== null) process.stdout.write(hit);
  else {
    const printer = await import("./vite-plugin/minimal.mts");
    const text =
      mode === "collector"
        ? printer.collectorFor(file, parsed)
        : mode === "served"
          ? await printer.servedFor(file, test!, parsed)
          : printer.minimalFor(file, test!, parsed);

    // `minimalFor` caches its own answer...
    // but `collectorFor` and `servedFor` don't, so do it here
    if (key && mode !== "test") write(key, text);

    process.stdout.write(text);
  }
}
