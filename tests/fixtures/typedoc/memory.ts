// A module documented by its tests, for the TypeDoc plugin's test (tests/typedoc.test.mts).
import type {
  Expect,
  Invoke,
  Table,
} from "../../../release/dsl.import.meta.vitest.ts";

/** Memory in MiB: "8g" is {@link parseMemory.Spellings | read}, and junk is not ({@link parseMemory.Junk}). */
export const parseMemory = (value: string): number | null =>
  value === "8g" ? 8192 : null;

declare namespace parseMemory {
  /** suffixes are read */
  export type Spellings = Table<
    typeof parseMemory,
    [[args: [value: "8g"], expected: 8192]]
  >;
  /** anything else is not memory */
  export type Junk = Expect<
    Invoke<typeof parseMemory, [value: "lots"]>,
    "=",
    null
  >;
}

/** Twice; see {@link parseMemory.Spellings} for another claim. */
export const double = (n: number) => n * 2;

// exported, which TypeDoc would otherwise give a page of its own
export declare namespace double {
  /** two is four */
  export type Two = Expect<Invoke<typeof double, [n: 2]>, "=", 4>;
}
