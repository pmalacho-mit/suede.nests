import type {
  Expect,
  Construct,
  Call,
  Given,
  Throws,
  Configure,
} from "../release/dsl.import.meta.vitest.ts";

export class Counter {
  #count: number;
  readonly step: number;
  readonly history: number[] = [];

  constructor(initial = 0, step = 1) {
    if (!Number.isInteger(initial))
      throw new RangeError("initial must be an integer");
    this.#count = initial;
    this.step = step;
  }

  get count(): number {
    return this.#count;
  }

  increment(times = 1): this {
    for (let i = 0; i < times; i++) {
      this.#count += this.step;
      this.history.push(this.#count);
    }
    return this;
  }

  reset(): void {
    this.#count = 0;
    this.history.length = 0;
  }
}

declare namespace Tests.Counter {
  // One instance per test. Every `Counter` reference below is *this* instance.
  type Counter = Construct<typeof Counter, [initial: 10, step: 2]>;

  export type InitialState = [
    Expect<Counter["count"], "=", 10>,
    Expect<Counter["history"], "isEmpty">,
  ];

  /** increment() advances by `step` and records history. */
  export type Increment = Given<
    Call<Counter, "increment", [3]>,
    [
      Expect<Counter["count"], "=", 16>,
      Expect<Counter["history"], "=", [12, 14, 16]>,
    ]
  >;

  /** increment() is chainable — it returns the same instance. */
  export type Chainable = Expect<Call<Counter, "increment">, "is", Counter>;

  /** reset() empties history, and does so on the same array object. */
  export type Reset = Given<
    [Call<Counter, "increment", [2]>, Call<Counter, "reset">],
    [
      Expect<Counter["count"], "=", 0>,
      Expect<Counter["history"], "isEmpty">,
      Expect<Counter["history"], "excludes", 12>,
    ]
  >;

  /** Each test gets a fresh instance: `Increment` above did not leak into this one. */
  export type Isolation = Expect<Counter["count"], "=", 10>;

  export type RejectsFractionalInitial = Throws<
    Construct<typeof Counter, [1.5]>,
    RangeError
  >;

  export type RejectsWithMessage = Throws<
    Construct<typeof Counter, [1.5]>,
    { instanceOf: RangeError; message: "integer" }
  >;

  export type Instance = Expect<Counter, "instanceOf", typeof Counter>;

  export type Slow = Configure<
    { timeout: 50 },
    Expect<Call<Counter, "increment", [1000]>["count"], "=", 2010>
  >;
}
