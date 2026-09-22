// Where a printed test is kept between runs, and how it is looked up.
//
// Loading TypeScript costs a fifth of a second before any work can start, so
// this module does not import it: the CLI can answer from the cache without
// paying for a compiler it will not use.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

/**
 * Pruning asks TypeScript to delete every unused declaration, over and over
 * until nothing is left to delete. That is worth paying once per test, not once
 * per run, so results are cached against the source they were derived from.
 */
export const cacheDir = path.join(".namespace-tests", "minimal");

/** This module's folder — the library's own, wherever it was installed. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The printer's own version, so a cached reproduction is never handed back by a
 * later printer that would have written it differently. Derived from the size
 * and mtime of the modules that do the printing — a handful of stats, once.
 */
const printerVersion = (() => {
  const files = [
    path.join(here, "minimal.mts"),
    ...fs
      .readdirSync(path.join(here, "emit"))
      .map((name) => path.join(here, "emit", name)),
  ];
  const stamp = files
    .map((file) => {
      const { size, mtimeMs } = fs.statSync(file);
      return `${path.basename(file)}:${size}:${Math.round(mtimeMs)}`;
    })
    .join("|");
  return createHash("sha256").update(stamp).digest("hex").slice(0, 8);
})();

/** What a cached reproduction is filed under. */
export const cacheKey = (
  source: string,
  testName: string,
  root = "",
  runtime = "",
) =>
  createHash("sha256")
    .update(`${printerVersion}\0${root}\0${runtime}\0${testName}\0${source}`)
    .digest("hex")
    .slice(0, 32);

/** Within one process, a printed test is only printed once. */
export const memo = new Map<string, string>();

/** What was printed for this key before, or null. */
export function read(key: string): string | null {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const onDisk = path.join(cacheDir, `${key}.ts`);
  if (!fs.existsSync(onDisk)) return null;
  const text = fs.readFileSync(onDisk, "utf8");
  memo.set(key, text);
  return text;
}

/** Keep what was printed, for this run and the next. */
export function write(key: string, text: string): void {
  memo.set(key, text);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${key}.ts`), text);
}

declare namespace cacheKey {
  /** what a test is filed under depends on everything that shaped it */
  export type Differs = Table<
    typeof differ,
    [
      [args: [["a.ts", "T"], ["a.ts", "T"]], expected: false],
      [args: [["a.ts", "T"], ["a.ts", "Other"]], expected: true],
      [args: [["a.ts", "T"], ["different source", "T"]], expected: true],
      [args: [["a.ts", "T", "Tests"], ["a.ts", "T", "Spec"]], expected: true],
      [args: [["a.ts", "T", "", "./rt.mts"], ["a.ts", "T"]], expected: true]
    ]
  >;
}

/** Test support: do these two lookups land on different entries? */
export const differ = (
  a: [string, string, string?, string?],
  b: [string, string, string?, string?],
) => cacheKey(...a) !== cacheKey(...b);
