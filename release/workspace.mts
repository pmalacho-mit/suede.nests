import type fs from "node:fs";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "out", "coverage"]);

export const isSearchable = (directory: fs.Dirent) =>
  !directory.name.startsWith(".") && !SKIPPED_DIRECTORIES.has(directory.name);
