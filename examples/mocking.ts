import type {
  Call,
  Expect,
  Given,
  Invoke,
  Mock,
  Mocked,
  Skip,
} from "../release/dsl.import.meta.vitest.ts";
import type { fakeRates, keepingTheRest } from "./lib/harness.ts";
import { exchangeRate, symbol } from "./lib/rates.ts";

export const inEuros = (dollars: number) => dollars * exchangeRate();

declare namespace inEuros {
  export type Plain = Expect<Invoke<typeof inEuros, [10]>, "=", 9>;

  /** rates.ts replaced by a module object the harness exports */
  export type Faked = Given<
    Mock<"./lib/rates.ts", typeof fakeRates>,
    Expect<Invoke<typeof inEuros, [10]>, "=", 20>
  >;

  /** every export of rates.ts a vi.fn(), and one of them told what to return */
  export type Stubbed = Given<
    [
      Mock<"./lib/rates.ts">,
      Call<Mocked<typeof exchangeRate>, "mockReturnValue", [3]>,
    ],
    Expect<Invoke<typeof inEuros, [10]>, "=", 30>
  >;

  /** each test mocks its own copy of rates.ts, so this one sees the real rate */
  export type Unmocked = Expect<Invoke<typeof inEuros, [10]>, "=", 9>;

  /** a package is shared by every test in this file, so the printer warns that its mock is too */
  export type APackage = Skip<
    Given<Mock<"node:os">, Expect<Invoke<typeof inEuros, [10]>, "=", 9>>,
    "shows the warning a package mock gets"
  >;

  /** a path that resolves to nothing is warned about, rather than silently mocking nothing */
  export type ATypo = Skip<
    Given<Mock<"./lib/ratez.ts">, Expect<Invoke<typeof inEuros, [10]>, "=", 9>>,
    "shows the warning a mistyped path gets"
  >;
}

export const formatted = (dollars: number) => `${symbol()}${inEuros(dollars)}`;

declare namespace formatted {
  /** a factory is handed importOriginal: the real symbol stays, the rate is replaced */
  export type Partly = Given<
    Mock<"./lib/rates.ts", typeof keepingTheRest>,
    Expect<Invoke<typeof formatted, [10]>, "=", "€40">
  >;
}
