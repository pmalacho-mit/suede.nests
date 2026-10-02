import type { Expect, Invoke } from "../release/dsl.import.meta.vitest.ts";

export const x = async () => 1 + 2;

declare namespace x {
  export type Simple = Expect<Invoke<typeof x>, "=", 3>;
}
