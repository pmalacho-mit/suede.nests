#!/usr/bin/env node
// `nt-minimal <file> <test> [--runtime <specifier>] [--root <namespace>]`
// `nt-minimal <file> <test> --served`
// `nt-minimal <file> --collector`
//
// Prints one test as a standalone file — with `--served`, as the plugin serves
// it, every first-party import carrying the test's tag; or, with `--collector`,
// the module Vitest is handed for the file itself: your code, plus the block
// that pulls in the generated tests. Anything the plugin has already printed is answered from
// the cache without loading TypeScript at all, which is the difference between
// 40ms and a second.
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { cacheKey, compileCacheDir, ensureDerived, read, write } from "./cache.mts";

// Most of what a cold run costs is Node compiling the library — TypeScript is
// about 10MB to parse — so the compiled form is kept between runs. A caller
// that knows better says so with `NODE_COMPILE_CACHE`, which Node reads before
// any of this is loaded and which therefore caches more; this is what makes the
// command fast on its own.
ensureDerived();
if (!process.env.NODE_COMPILE_CACHE)
  module.enableCompileCache?.(compileCacheDir);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const [file, testName] = args.filter(
  (arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
);
const wholeFile = args.includes("--collector");
const served = args.includes("--served");

if (!file || (!testName && !wholeFile)) {
  console.error(
    "usage: nt-minimal <file.ts> <TestName> [--runtime <spec>] [--root <ns>]\n" +
      "       nt-minimal <file.ts> --collector",
  );
  process.exit(2);
}

const root = flag("root");
const runtime = flag("runtime");
const source = fs.existsSync(file)
  ? fs.readFileSync(path.resolve(file), "utf8")
  : null;

// `--collector` is about the file, not one test of it, so it is filed under a
// name no test can have.
const key =
  source === null
    ? null
    : cacheKey(
        source,
        wholeFile ? "\0collector" : served ? `\0served ${testName}` : testName!,
        root,
        runtime,
      );
const hit = key === null ? null : read(key);

if (hit !== null) {
  process.stdout.write(hit);
} else if (wholeFile) {
  // only now is a compiler worth its quarter of a second
  const { collectorFor } = await import("./minimal.mts");
  const text = collectorFor(file, { root, runtime });
  if (key) write(key, text);
  process.stdout.write(text);
} else if (served) {
  const { servedFor } = await import("./minimal.mts");
  const text = await servedFor(file, testName!, { root, runtime });
  if (key) write(key, text);
  process.stdout.write(text);
} else {
  const { minimalFor } = await import("./minimal.mts");
  process.stdout.write(minimalFor(file, testName!, { root, runtime }));
}
