import path from "node:path";

import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

export const posix = (file: string) => file.split(path.sep).join("/");

export const relativeTo = (dir: string, file: string) => posix(path.relative(dir, file));

export const importPath = (importer: string, file: string) => {
  const rel = relativeTo(path.dirname(importer), file);
  return rel.startsWith(".") ? rel : `./${rel}`;
};

const isInstalled = (file: string) =>
  file.includes(`${path.sep}node_modules${path.sep}`);

// an installed runtime is imported by its package name, which is the printer's default
export const runtimeSpecifier = (runtime: string, importer: string) =>
  isInstalled(runtime) ? undefined : importPath(importer, runtime);

declare namespace importPath {
  export type Relative = Table<
    typeof importPath,
    [
      [args: ["/p/src/a.ts", "/p/src/runtime.mts"], expected: "./runtime.mts"],
      [args: ["/p/src/a.ts", "/p/lib/runtime.mts"], expected: "../lib/runtime.mts"],
    ]
  >;
}

declare namespace runtimeSpecifier {
  export type Installed = Expect<
    Invoke<typeof runtimeSpecifier, ["/p/node_modules/nt/runtime.mts", "/p/src/a.ts"]>,
    "=",
    undefined
  >;
}
