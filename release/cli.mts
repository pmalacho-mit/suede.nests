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

/** What to print for a file: one test, one test as served, or the whole file. */
export type Mode = "test" | "served" | "collector";

/**
 * What was asked for, read off an argv. Kept apart from acting on it, so the
 * reading can be tested without a process to exit.
 */
export function request(argv: string[]) {
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
  const mode: Mode = args.collector
    ? "collector"
    : args.served
      ? "served"
      : "test";
  return {
    file: args[0],
    test: args[1],
    mode,
    root: args.root,
    runtime: args.runtime,
    help: args.help,
  };
}

declare namespace request {
  /** a file and a test: the test, as it would be extracted */
  export type Test = Expect<
    Invoke<typeof request, [["src/a.ts", "a > B"]]>,
    "matches",
    { file: "src/a.ts"; test: "a > B"; mode: "test" }
  >;

  export type Served = Expect<
    Invoke<typeof request, [["src/a.ts", "a > B", "--served"]]>,
    "matches",
    { mode: "served" }
  >;

  /** the whole file needs no test to be named */
  export type Collector = Expect<
    Invoke<typeof request, [["src/a.ts", "--collector"]]>,
    "matches",
    { file: "src/a.ts"; test: undefined; mode: "collector" }
  >;

  /** a flag may come first: a boolean takes nothing from what follows it */
  export type FlagFirst = Expect<
    Invoke<typeof request, [["--collector", "src/a.ts"]]>,
    "matches",
    { file: "src/a.ts"; mode: "collector" }
  >;

  /** a flag's value is its own, not the next positional */
  export type Runtime = Expect<
    Invoke<
      typeof request,
      [["src/a.ts", "a > B", "--runtime", "../vite-plugin/runtime.mts"]]
    >,
    "matches",
    { test: "a > B"; runtime: "../vite-plugin/runtime.mts" }
  >;
}

if (cli.entry(import.meta.url)) {
  // Most of what a cold run costs is Node compiling the library — TypeScript is
  // about 10MB to parse — so the compiled form is kept between runs. A caller
  // that knows better says so with `NODE_COMPILE_CACHE`, which Node reads
  // before any of this is loaded and which therefore caches more; this is what
  // makes the command fast on its own.
  ensureDerived();
  if (!process.env.NODE_COMPILE_CACHE)
    module.enableCompileCache?.(compileCacheDir);

  const { file, test, mode, root, runtime, help } = request(
    process.argv.slice(2),
  );
  if (!file || (mode !== "collector" && !test)) {
    console.error(help());
    process.exit(2);
  }

  const source = fs.existsSync(file)
    ? fs.readFileSync(path.resolve(file), "utf8")
    : null;

  // The whole file, and a test as served, are filed under names no test can
  // have, so they never land on a test's own entry.
  const name =
    mode === "collector"
      ? "\0collector"
      : mode === "served"
        ? `\0served ${test}`
        : test!;
  const key = source === null ? null : cacheKey(source, name, root, runtime);
  const hit = key === null ? null : read(key);

  if (hit !== null) process.stdout.write(hit);
  else {
    // only now is a compiler worth its quarter of a second
    const printer = await import("./vite-plugin/minimal.mts");
    const text =
      mode === "collector"
        ? printer.collectorFor(file, { root, runtime })
        : mode === "served"
          ? await printer.servedFor(file, test!, { root, runtime })
          : printer.minimalFor(file, test!, { root, runtime });
    // `minimalFor` files its own answer; the other two are filed here
    if (key && mode !== "test") write(key, text);
    process.stdout.write(text);
  }
}
