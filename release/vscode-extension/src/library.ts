// Finding the library in the workspace.
//
// The DSL's filename is the one fixed point: wherever this library was
// installed — vendored beside your code or inside node_modules — the entry is
// `dsl.import.meta.vitest.ts`, and the plugin sits next to it.
import fs from "node:fs";
import path from "node:path";

const found = new Map<string, Library | null>();

export type Library = {
  /** The folder the release was installed into. */
  root: string;
  /** The command line that prints a test — or a whole file — as Vitest sees it. */
  minimal: string;
  /** The runtime generated tests import `ntCheck` from. */
  runtime: string;
  /** The reporter that records what a failure actually saw, diff and all. */
  reporter: string;
};

const DSL = "dsl.import.meta.vitest.ts";

/** Walks down from the workspace folder, skipping the places it cannot be. */
export function findLibrary(folder: string): Library | null {
  const cached = found.get(folder);
  if (cached !== undefined) return cached;

  const skip = new Set(["node_modules", "dist", "out", "coverage"]);
  const queue = [folder];
  let library: Library | null = null;

  while (queue.length && !library) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith("."))
          queue.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.name !== DSL) continue;
      // the command line sits beside the DSL
      const cli = path.join(dir, "cli.mts");
      if (fs.existsSync(cli)) {
        library = {
          root: dir,
          minimal: cli,
          runtime: path.join(dir, "vite-plugin", "runtime.mts"),
          reporter: path.join(dir, "vite-plugin", "reporter.mts"),
        };
        break;
      }
    }
  }

  found.set(folder, library);
  return library;
}

/** Forget what we found, for when the workspace changes underneath us. */
export const forgetLibrary = () => found.clear();
