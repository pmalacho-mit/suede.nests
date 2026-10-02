import type {
  Expect,
  Invoke,
  Throws,
} from "../release/dsl.import.meta.vitest.ts";
export const add = (a: number, b: number, c = 0) => a + b + c;
export const user = () => ({ name: "ada", age: 36 });
declare namespace Tests.wrong {
  export type OffByOne = Expect<Invoke<typeof add, [4, 5]>, "=", 10>;
  /** `matches` compares only the keys listed, and this one is wrong */
  export type Shape = Expect<
    Invoke<typeof user>,
    "matches",
    { name: "bob" }
  >;
  export type DidNotThrow = Throws<Invoke<typeof add, [1, 1]>>;
  export type NotAValue = Expect<
    Invoke<typeof add, [1_000_000, 2_000_000, 30]>,
    "=",
    number
  >;
}
