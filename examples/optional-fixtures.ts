import type { Expect, FromFile, Invoke, SkipIfNotFound } from "../release/dsl.import.meta.vitest.ts";

export const countUsers = (users: unknown[]) => users.length;

declare namespace countUsers {
  /** the fixture is in this repository, so the test runs */
  export type Shipped = SkipIfNotFound<
    "./fixtures/users.json",
    Expect<Invoke<typeof countUsers, [FromFile<"./fixtures/users.json", "json", unknown[]>]>, ">", 0>
  >;

  /** a fixture that is not here, as in an installed copy of a library: the test is skipped */
  export type NotShipped = SkipIfNotFound<
    "./fixtures/archive.json",
    Expect<Invoke<typeof countUsers, [FromFile<"./fixtures/archive.json", "json", unknown[]>]>, ">", 0>
  >;
}
