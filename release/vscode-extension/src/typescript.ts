// The TypeScript the extension parses with: the project's own, not a copy.
//
// Discovery only parses — it never type-checks — and what it parses has to
// agree with the plugin, which decides what actually runs. So rather than bundle
// a compiler frozen at build time, the bundle resolves the one the library
// itself imports. The library cannot run without it, so wherever there is
// anything to discover, it is there.
//
// In the bundle, `import ts from "typescript"` resolves *here* (see build.mjs):
// the default export stands in for the module and loads the real one on first
// use. Source that imports TypeScript is written as though nothing were
// different, and under Vitest nothing is.
import { createRequire } from "node:module";
import path from "node:path";

import type TS from "typescript";
import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";

const loaded = new Map<string, typeof TS | null>();

/**
 * The TypeScript a folder resolves, found the way Node would from there — or
 * null when there is none: a workspace without the library, say, or one whose
 * packages Node cannot see (Yarn's Plug'n'Play).
 */
export function typescriptOf(dir: string): typeof TS | null {
  const known = loaded.get(dir);
  if (known !== undefined) return known;
  let found: typeof TS | null = null;
  try {
    const require = createRequire(path.join(dir, "noop.js"));
    found = require(require.resolve("typescript")) as typeof TS;
  } catch {
    found = null;
  }
  loaded.set(dir, found);
  return found;
}

/** Where the next parse gets its TypeScript from. */
let from: string = process.cwd();

/**
 * Parse with the TypeScript the library in `dir` uses. Discovery is
 * synchronous, so setting this before a call is enough for that call.
 * @returns whether there is one to parse with.
 */
export function parseWithTypeScriptOf(dir: string): boolean {
  from = dir;
  return typescriptOf(dir) !== null;
}

/** The module, as `import ts from "typescript"` sees it in the bundle. */
export default new Proxy({} as typeof TS, {
  get(_, key) {
    const ts = typescriptOf(from);
    if (!ts)
      throw new Error(`namespace-tests: no TypeScript to parse with from ${from}`);
    return ts[key as keyof typeof TS];
  },
});

declare namespace typescriptOf {
  /** this repository has one, as any project using the library does */
  export type Found = Expect<
    Invoke<typeof typescriptOf, ["."]>,
    "defined"
  >;

  /** and nothing above it can be found from the root of the filesystem */
  export type Missing = Expect<Invoke<typeof typescriptOf, ["/"]>, "is", null>;
}
