import type {
  Call,
  Construct,
  Expect,
  Invoke,
} from "../release/dsl.import.meta.vitest.ts";

export const none = () => "none";
export const optional = (a?: number) => a ?? "absent";
export const defaulted = (a = 4) => a;
export const variadic = (...xs: number[]) => xs.length;
export const required = (a: number) => a;

export class Tally {
  count: number;
  constructor(start = 0) {
    this.count = start;
  }
  bump(by = 1) {
    return (this.count += by);
  }
  set(to: number) {
    return (this.count = to);
  }
}

export class Named {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

declare namespace none {
  export type Omitted = Expect<Invoke<typeof none>, "=", "none">;
  export type Empty = Expect<Invoke<typeof none, []>, "=", "none">;
}

declare namespace optional {
  export type Omitted = Expect<Invoke<typeof optional>, "=", "absent">;
  export type Given = Expect<Invoke<typeof optional, [a: 1]>, "=", 1>;
}

declare namespace defaulted {
  export type Omitted = Expect<Invoke<typeof defaulted>, "=", 4>;
}

declare namespace variadic {
  export type Omitted = Expect<Invoke<typeof variadic>, "=", 0>;
}

declare namespace Tally {
  type Tally = Construct<typeof Tally>;

  export type Omitted = Expect<Call<Tally, "bump">, "=", 1>;
  export type Empty = Expect<Call<Construct<typeof Tally, []>, "bump", []>, "=", 1>;
}

// A parameter without a default must be given, even as an empty tuple.
export type Rejected = [
  // @ts-expect-error
  Invoke<typeof required>,
  // @ts-expect-error
  Invoke<typeof required, []>,
  // @ts-expect-error
  Construct<typeof Named>,
  // @ts-expect-error
  Construct<typeof Named, []>,
  // @ts-expect-error
  Call<Construct<typeof Tally>, "set">,
  // @ts-expect-error
  Call<Construct<typeof Tally>, "set", []>,
];
