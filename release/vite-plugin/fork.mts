// Per-test module isolation.
//
// A generated test is served with every first-party specifier carrying the
// test's tag, so `./money.ts` is a different module for every test that reaches
// it and state cannot leak from one to the next. `resolveId` reads the tag back
// off the id — and drops it for a module the tests are meant to share.
import { init, parse } from "es-module-lexer";

import type { ImportSpecifier } from "es-module-lexer";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

/** The query a forked module id carries. */
export const FORK = "namespace-test";

/** The fork a module id belongs to, if any. */
export const forkOf = (id: string) => {
  const [file = "", query = ""] = id.split("?");
  const tag = new URLSearchParams(query).get(FORK);
  return tag ? { file, tag } : null;
};

/**
 * Give a module's own imports the fork's tag. The specifiers come from the
 * module's own import statements, as `es-module-lexer` reads them off — never
 * by matching text: a string that merely *looks* like an import, a snippet of
 * source held in a constant say, must be left alone.
 */
export async function fork(code: string, tag: string): Promise<string> {
  let imports: readonly ImportSpecifier[];
  try {
    await init;
    [imports] = parse(code);
  } catch {
    return code; // not lexable here; leave it to the rest of the pipeline
  }
  let out = "";
  let last = 0;
  // the lexer reports them in source order, so one pass rewrites them all
  for (const { n: spec, s: start, e: end, d: dynamic } of imports) {
    // `n` is undefined for `import.meta` and for a dynamic specifier that is
    // not a plain string — neither names a module we could fork
    if (!spec?.startsWith(".")) continue;
    const tagged = `${spec}${spec.includes("?") ? "&" : "?"}${FORK}=${tag}`;
    // a static import's span is the specifier inside its quotes; a dynamic
    // one's is the whole literal, which may be a template
    out += code.slice(last, start);
    out += dynamic > -1 ? JSON.stringify(tagged) : tagged;
    last = end;
  }
  return out + code.slice(last);
}

declare namespace fork {
  /** a first-party import becomes this test's own copy of that module */
  export type Tags = Expect<
    Invoke<typeof fork, ['import { a } from "./m.ts";', "t"]>,
    "=",
    'import { a } from "./m.ts?namespace-test=t";'
  >;

  /** a package is not ours to fork: Node would not know the query */
  export type LeavesPackages = Expect<
    Invoke<typeof fork, ['import ts from "typescript";', "t"]>,
    "=",
    'import ts from "typescript";'
  >;

  /** a string that merely looks like one is a string */
  export type LeavesStrings = Expect<
    Invoke<typeof fork, ['const s = \'import { a } from "./m.ts";\';', "t"]>,
    "=",
    'const s = \'import { a } from "./m.ts";\';'
  >;

  /** a dynamic import is rewritten as the literal it was */
  export type Dynamic = Expect<
    Invoke<typeof fork, ['await import("./m.ts");', "t"]>,
    "=",
    'await import("./m.ts?namespace-test=t");'
  >;
}

declare namespace forkOf {
  export type Reads = Table<
    typeof forkOf,
    [
      [args: ["/a/m.ts?namespace-test=t&lang.ts"], cond: "matches", expected: { file: "/a/m.ts"; tag: "t" }],
      [args: ["/a/m.ts"], cond: "is", expected: null]
    ]
  >;
}
