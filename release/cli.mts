#!/usr/bin/env node
// The library's command line: one namespace test, printed as a file.
//
//   cli.mts <file> <test>                  the test, as a standalone Vitest file
//   cli.mts <file> <test> --served         as the plugin serves it, imports tagged
//   cli.mts <file> --collector             the module Vitest is handed for the file
//
// It sits beside the DSL rather than in `vite-plugin/` because nothing in the
// plugin calls it: it is a front end onto the same printer, for the editor and
// for anyone at a terminal. Anything a run has already printed is answered from
// the cache without loading TypeScript at all, which is the difference between
// 40ms and a second.
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { cli, main } from "./vendored/typescript-cli-suede/index.ts";
import {
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
  ]);
  return {
    file: args[0],
    test: args[1],
    mode: args.collector ? "collector" : args.served ? "served" : "test",
    root: args.root,
    runtime: args.runtime,
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
  tryCacheNodeCompilation();

  const parsed = parse(process.argv.slice(2));
  const { file, test, mode, help } = parsed;

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
