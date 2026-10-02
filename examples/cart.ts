import type {
  Expect,
  Invoke,
  Given,
  Construct,
  Call,
} from "../release/dsl.import.meta.vitest.ts";
import { conversionCount, formatCents } from "./lib/money.ts";

/**
 * A first-party import is used exactly as the module uses it.
 *
 * NOTE: normally this testing should go inside the module itself,
 * but for testing purposes is included here.
 */
declare namespace formatCents {
  export type Formats = Expect<
    Invoke<typeof formatCents, [1234]>,
    "=",
    "$12.34"
  >;

  export type Negative = Expect<
    Invoke<typeof formatCents, [-5]>,
    "=",
    "-$0.05"
  >;
}

/**
 * Each test gets its own copy of `./lib/money.ts`, so the count this test
 * sees is its own. Both of these pass only because the import is isolated.
 */
declare namespace Isolation {
  export type IsolatedFirst = Given<
    Invoke<typeof formatCents, [1]>,
    Expect<Invoke<typeof conversionCount>, "=", 1>
  >;

  export type IsolatedSecond = Given<
    Invoke<typeof formatCents, [2]>,
    Expect<Invoke<typeof conversionCount>, "=", 1>
  >;
}

export class Cart {
  readonly lines: number[] = [];

  add(cents: number): this {
    this.lines.push(cents);
    return this;
  }

  get total(): number {
    return this.lines.reduce((sum, line) => sum + line, 0);
  }

  receipt(): string {
    return formatCents(this.total);
  }
}

declare namespace Cart {
  type Cart = Construct<typeof Cart>;

  /** the imported module is reached through the class under test */
  export type Receipt = Given<
    [Call<Cart, "add", [1099]>, Call<Cart, "add", [250]>],
    Expect<Call<Cart, "receipt">, "=", "$13.49">
  >;
}
