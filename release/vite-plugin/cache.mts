// Where things go: what the library hands the editor, and what it keeps for
// itself.
//
// Loading TypeScript costs a fifth of a second before any work can start, so
// this module does not import it: the CLI can answer from the cache without
// paying for a compiler it will not use.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Table, Invoke } from "../dsl.import.meta.vitest.ts";

/** This module's folder — the library's own, wherever it was installed. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Everything the library writes, in the library's own folder rather than in
 * yours. Nothing in it is authored: every file is derived from your source, by
 * this library, for this library — which is why it is called that, why it is
 * not yours to read or edit, and why deleting it costs nothing but the time to
 * write it again.
 *
 *     .derived/
 *     ├── diagnostics.json   what the printer could not turn into a value
 *     ├── results.json       what the reporter saw, the editor explains
 *     └── cache/             only ever an optimisation; delete it freely
 *         ├── minimal/       tests the printer has already written out
 *         └── node/          Node's compiled-module cache
 *
 * `NAMESPACE_TESTS_DIR` moves it, which the library's own end-to-end test needs
 * so that a run inside a run does not write over what the outer one wrote.
 * There is no reason to set it otherwise.
 */
export const DERIVED =
  process.env.NAMESPACE_TESTS_DIR ?? path.join(here, "..", ".derived");

/**
 * Printing a test means building a program over its file and following what
 * it reaches. That is worth paying once per test, not once per run, so results
 * are cached against the source they were derived from, and against the
 * version of the printer that wrote them.
 */
export const cacheDir = path.join(DERIVED, "cache", "minimal");

/** Node's compiled-module cache, kept beside the printer's. */
export const compileCacheDir = path.join(DERIVED, "cache", "node");

export const caches = [cacheDir, compileCacheDir];

/**
 * Make sure the library's folder exists and keeps itself out of the repository.
 * Every write goes through here.
 */
export function ensureDerived(dir = DERIVED): string {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(DERIVED, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

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
  fs.writeFileSync(path.join(ensureDerived(cacheDir), `${key}.ts`), text);
}

declare namespace cacheKey {
  type Key<
    Source extends string,
    TestName extends string,
    Root extends string | undefined = undefined,
  > = Invoke<typeof cacheKey, [Source, TestName, Root]>;

  /** what a test is filed under depends on everything that shaped it */
  export type Differs = Table<
    typeof cacheKey,
    [
      [args: ["a.ts", "T"], condition: "=", expected: Key<"a.ts", "T">],
      [args: ["a.ts", "T"], condition: "!=", expected: Key<"a.ts", "Other">],
      [
        args: ["a.ts", "T"],
        condition: "!=",
        expected: Key<"different source", "T">,
      ],
      [
        args: ["a.ts", "T", "Tests"],
        condition: "!=",
        expected: Key<"a.ts", "T", "Spec">,
      ],
      [
        args: ["a.ts", "T", "", "./rt.mts"],
        condition: "!=",
        expected: Key<"a.ts", "T">,
      ],
    ]
  >;
}
