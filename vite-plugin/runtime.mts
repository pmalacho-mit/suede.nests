// What a printed test calls for the DSL's values that are more than a literal:
// `Caught`, `TempDir`, `WriteFile`, `Exists`, `ListDir`. A printed test imports
// it as `nt`, so what Vitest runs reads as the type did: `nt.tempDir({ … })`.
//
// Each is one small function with one meaning, so the printed test, the
// extracted test, and the docs all say the same thing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as { then?: unknown }).then === "function";

const didNotThrow = (source: string, how: string) =>
  new Error(
    `namespace-tests: expected \`${source}\` to ${how}, and it did not`,
  );

/**
 * The error `run` throws, or the reason the promise it returns rejects. Throws
 * when it does neither, so a `Caught` that catches nothing fails its test.
 */
export function caught(run: () => unknown, source: string): any {
  let value: unknown;
  try {
    value = run();
  } catch (error) {
    return error;
  }
  if (isThenable(value))
    return Promise.resolve(value).then(
      () => {
        throw didNotThrow(source, "reject");
      },
      (error: unknown) => error,
    );
  throw didNotThrow(source, "throw");
}

/** `text` at `file`, its directories made first. */
export function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * A fresh directory holding `files` (paths relative to it), removed when the
 * test ends. Its real path, so it compares equal to what the code resolves.
 */
export function tempDir(files: { readonly [name: string]: string }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nests-")));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files))
    writeFile(path.join(dir, name), text);
  return dir;
}

/** Whether anything is at `file`. */
export const exists = (file: string): boolean => fs.existsSync(file);

/** The names in `dir`, sorted. */
export const listDir = (dir: string): string[] => fs.readdirSync(dir).sort();
