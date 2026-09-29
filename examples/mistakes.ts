// Deliberate type errors, so this file is left out of tsconfig.json's typecheck.
import type { Expect, Invoke, Skip, Table } from "../release/dsl.import.meta.vitest.ts";

export const scrubsTests = (define: Record<string, unknown> | undefined) =>
  typeof define?.["import.meta.vitest"] === "string";

declare namespace scrubsTests {
  /** TypeScript reports only row 2; the printer names row 3 as well, each on the cell that is wrong */
  export type Rows = Skip<
    Table<
      typeof scrubsTests,
      [
        [args: [{ "import.meta.vitest": "undefined" }], expected: true],
        [args: [{}], expected: "no"],
        [args: ["wrong"], expected: false],
        [args: [undefined], expected: false],
      ]
    >,
    "deliberate mistakes in rows 2 and 3"
  >;

  /** row 2 names a condition a boolean does not have; row 1 is wrong too, but the DSL's Row type accepts it */
  export type Conditions = Skip<
    Table<
      typeof scrubsTests,
      [
        [args: [undefined], condition: "=", expected: "maybe"],
        [args: [{}], condition: "startsWith", expected: true],
      ]
    >,
    "deliberate mistakes in rows 1 and 2"
  >;

  /** the error lands on "no", said in terms of the actual value rather than the DSL's internals */
  export type Single = Skip<Expect<Invoke<typeof scrubsTests, [{}]>, "=", "no">, "a deliberate mistake">;
}
