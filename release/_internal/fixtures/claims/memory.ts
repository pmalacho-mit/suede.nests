// A subject for the editor plugin's tests (release/ts-plugin): a function with
// tests, which uses-memory.ts calls from another file. Read by the plugin's
// harness, never collected: fixtures are left out of the run.
import type { Invoke, Table, Throws } from "../../../dsl.import.meta.vitest.ts";

/** Memory in MiB, from "8g" or "512m"; null for anything else. */
export const parseMemory = (value: string): number | null => {
  if (value === "") throw new Error("empty");
  const found = /^(\d+)([gm])$/.exec(value);
  return found ? Number(found[1]) * (found[2] === "g" ? 1024 : 1) : null;
};

declare namespace parseMemory {
  /** suffixes are read */
  export type Spellings = Table<
    typeof parseMemory,
    [
      [args: [value: "8g"], expected: 8192],
      [args: [value: "512m"], expected: 512],
      [args: [value: "lots"], expected: null],
    ]
  >;

  /** nothing is no memory, not zero */
  export type Empty = Throws<Invoke<typeof parseMemory, [value: ""]>, "empty">;
}
