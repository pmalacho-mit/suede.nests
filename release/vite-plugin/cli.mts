#!/usr/bin/env node
// `nt-minimal <file> <test> [--runtime <specifier>] [--root <namespace>]`
//
// Prints one test as a standalone file. A test the plugin has already printed —
// every test in a file the editor just ran — is answered from the cache without
// loading TypeScript at all, which is the difference between 40ms and a second.
import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { cacheKey, compileCacheDir, ensureDerived, read } from "./cache.mts";

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
  (arg, index) =>
    !arg.startsWith("--") && !args[index - 1]?.startsWith("--"),
);

if (!file || !testName) {
  console.error("usage: nt-minimal <file.ts> <TestName> [--runtime <spec>] [--root <ns>]");
  process.exit(2);
}

const root = flag("root");
const runtime = flag("runtime");

const hit = fs.existsSync(file)
  ? read(cacheKey(fs.readFileSync(path.resolve(file), "utf8"), testName, root, runtime))
  : null;

if (hit !== null) {
  process.stdout.write(hit);
} else {
  // only now is a compiler worth its quarter of a second
  const { minimalFor } = await import("./minimal.mts");
  process.stdout.write(minimalFor(file, testName, { root, runtime }));
}
