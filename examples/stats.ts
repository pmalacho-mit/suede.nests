import type { Expect, Invoke, Table, Widen, Configure } from "../release/dsl.import.meta.vitest.ts";

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return NaN;
  return Array.from(xs).reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function histogram(
  xs: readonly number[],
  buckets: number,
  min: number,
  max: number,
): Uint32Array {
  const out = new Uint32Array(buckets);
  const width = (max - min) / buckets;
  for (const x of xs) {
    const b = Math.min(buckets - 1, Math.max(0, Math.floor((x - min) / width)));
    out[b] = (out[b] ?? 0) + 1;
  }
  return out;
}

export function normalize(xs: readonly number[]): Float64Array {
  const m = mean(xs);
  const s = stddev(xs) || 1;
  return Float64Array.from(xs, (x) => (x - m) / s);
}

declare namespace Tests.mean {
  type Sample = Widen<[2, 4, 4, 4, 5, 5, 7, 9]>; // number[] — one array per test

  export type Basic = Expect<Invoke<typeof mean, [Sample]>, "=", 5>;
  export type Empty = Expect<Invoke<typeof mean, [[]]>, "isNaN">;
  export type FloatingPoint = Expect<
    Invoke<typeof mean, [[0.1, 0.2, 0.3]]>,
    ["~=", 1e-15],
    0.2
  >;
  export type Integer = Expect<Invoke<typeof mean, [[1, 3]]>, "isInteger">;
  export type Bounded = [
    Expect<Invoke<typeof mean, [Sample]>, ">=", 2>,
    Expect<Invoke<typeof mean, [Sample]>, "<=", 9>,
    Expect<Invoke<typeof mean, [Sample]>, "isFinite">,
  ];
}

declare namespace Tests.stddev {
  export type Textbook = Expect<
    Invoke<typeof stddev, [[2, 4, 4, 4, 5, 5, 7, 9]]>,
    "=",
    2
  >;
  export type Constant = Expect<Invoke<typeof stddev, [[3, 3, 3]]>, "=", 0>;
  export type Cases = Table<
    typeof stddev,
    [
      [args: [values: [1, 1]], expected: 0],
      [args: [values: [0, 2]], expected: 1],
      [
        args: [values: [1, 2, 3, 4]],
        condition: ["~=", 1e-12],
        expected: 1.118033988749895,
      ],
    ]
  >;
}

declare namespace _import.meta.vitest {}

declare namespace Tests.histogram {
  type H = Invoke<typeof histogram, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5, 0, 10]>;

  /** Typed arrays compare element-wise against tuples. */
  export type EvenSpread = Expect<H, "=", [2, 2, 2, 2, 2]>;
  export type Length = Expect<H["length"], "=", 5>;
  export type Clamps = Expect<
    Invoke<typeof histogram, [[-100, 100], 2, 0, 10]>,
    "=",
    [1, 1]
  >;
  export type Sum = Expect<H, "satisfies", typeof sumsToTen>;

  /** Bar chart instead of a wall of numbers when this fails. */
  export type Visual = Expect<
    Invoke<typeof histogram, [[1, 1, 1, 2, 3, 5, 8, 13], 4, 0, 16]>,
    "=",
    [5, 1, 1, 1],
    "./display-histogram.html"
  >;
}

declare namespace Tests.normalize {
  type N = Invoke<typeof normalize, [[1, 2, 3]]>;
  export type ZeroMean = Expect<Invoke<typeof mean, [N]>, ["~=", 1e-12], 0>;
  export type Ends = [
    Expect<N[0], ["~=", 1e-12], -1.224744871391589>,
    Expect<N[2], ["~=", 1e-12], 1.224744871391589>,
  ];
  export type Includes = Expect<N, "includes", 0>;
  export type Ordered = Expect<N, "every", typeof isFinite>;

  export type Big = Configure<
    { timeout: 30_000; retries: 1 },
    Expect<
      Invoke<typeof normalize, [Invoke<typeof range, [1_000_000]>]>["length"],
      "=",
      1_000_000
    >
  >;
}

export const sumsToTen = (h: Uint32Array) =>
  h.reduce((a, b) => a + b, 0) === 10;
export const isFinite = (x: number) => Number.isFinite(x);
export const range = (n: number) => Array.from({ length: n }, (_, i) => i);
