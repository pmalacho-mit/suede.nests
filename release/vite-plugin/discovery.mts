// Which files hold tests: what the plugin scans for, and what the docs, the
// editor and TypeDoc read. One rule, so they never disagree about a file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import picomatch from "picomatch";

import { relativeTo } from "./paths.mts";

export const isTypeScript = (file: string) => /\.[cm]?tsx?$/.test(file);

// line-anchored, so a mention in a comment is not one; the printer decides what is a test
export const testNamespaceMarker = (root?: string) =>
  new RegExp(`^\\s*declare\\s+namespace\\s+${root ?? "\\w"}`, "m");

const MARKER = testNamespaceMarker();

/** Whether a module's text may hold tests: the printer decides which of its aliases are. */
export const holdsTests = (text: string) => MARKER.test(text);

/** The library's own folder, which a project that vendors it does not test or document. */
export const LIBRARY = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

export type Discovery = {
  cwd: string;
  /** Globs, relative to `cwd`. */
  exclude: string[];
  marker: RegExp;
  skip: string | null;
};

// `src/fixtures/**` should stop the walk at `src/fixtures`, not only reject what is under it
const asDirectories = (globs: string[]) =>
  globs.map((glob) => glob.replace(/\/\*\*(\/\*)?$/, ""));

const isHidden = (entry: fs.Dirent) =>
  entry.name === "node_modules" || entry.name.startsWith(".");

/** A walk from a directory that yields each module holding tests. */
export function testModuleFinder({ cwd, exclude, marker, skip }: Discovery) {
  const excluded = picomatch(exclude, { dot: true });
  const excludedDir = picomatch(asDirectories(exclude), { dot: true });

  const holds = (file: string) =>
    isTypeScript(file) &&
    !file.endsWith(".d.ts") &&
    !excluded(relativeTo(cwd, file)) &&
    marker.test(fs.readFileSync(file, "utf8"));

  function* under(dir: string): Generator<string> {
    if (path.resolve(dir) === skip) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isHidden(entry)) continue;
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDir(relativeTo(cwd, at))) yield* under(at);
      } else if (holds(at)) yield at;
    }
  }
  return under;
}
