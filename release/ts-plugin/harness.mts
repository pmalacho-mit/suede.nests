/// <reference types="node" />
// Harness for the in-source tests of claims.mts: what a language service would
// hand the plugin, a program over two files, one calling the other. It stands in
// for tsserver, which no test can start. Imported `import type` only.
import path from "node:path";
import ts from "@typescript/typescript6";

import { hoverClaims, rowHints } from "./claims.mts";
import { OPTIONS } from "../_internal/harness.mts";

const FIXTURES = path.join(
  import.meta.dirname,
  "..",
  "_internal",
  "fixtures",
  "claims",
);

let program: ts.Program | undefined;

const programOf = () =>
  (program ??= ts.createProgram(
    ["memory.ts", "uses-memory.ts"].map((f) => path.join(FIXTURES, f)),
    OPTIONS,
  ));

const sourceOf = (file: string) => {
  const source = programOf().getSourceFile(path.join(FIXTURES, file));
  if (!source) throw new Error(`no fixture ${file}`);
  return source;
};

/** What the hover adds where `needle` first starts in a fixture. */
export function hoverOn(file: string, needle: string): string | null {
  const source = sourceOf(file);
  const at = source.text.indexOf(needle);
  if (at < 0) throw new Error(`${needle} is not in ${file}`);
  return hoverClaims(programOf(), source.fileName, at);
}

/** The inlay hints over a whole fixture, as their text. */
export const hintsIn = (file: string): string[] => {
  const source = sourceOf(file);
  return rowHints(programOf(), source.fileName, {
    start: 0,
    length: source.text.length,
  }).map((h) => h.text);
};
