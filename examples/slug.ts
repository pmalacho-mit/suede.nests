import type { Expect, Invoke, Table, Skip, Todo } from "../release/dsl.import.meta.vitest.ts";

/** Turn arbitrary text into a URL-safe slug. */
export function slugify(input: string, maxLength = 64): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

export function truncate(input: string, max: number, ellipsis = "…"): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

declare namespace Tests.slugify {
  /** Punctuation collapses into single dashes. */
  export type Basic = Expect<
    Invoke<typeof slugify, ["Hello, World!"]>,
    "=",
    "hello-world"
  >;

  /** Diacritics are stripped rather than dropped. */
  export type Diacritics = Expect<
    Invoke<typeof slugify, ["Crème Brûlée"]>,
    "=",
    "creme-brulee"
  >;

  /** Output only ever contains lowercase letters, digits and dashes. */
  export type Charset = Expect<
    Invoke<typeof slugify, ["  Ünïcode & symbols ~~ 42 "]>,
    "matches",
    "^[a-z0-9-]*$"
  >;

  export type NoLeadingOrTrailingDash = [
    Expect<Invoke<typeof slugify, ["--foo--"]>, "startsWith", "f">,
    Expect<Invoke<typeof slugify, ["--foo--"]>, "endsWith", "o">,
    Expect<Invoke<typeof slugify, ["--foo--"]>, "excludes", "--">,
  ];

  export type Edge = Table<
    typeof slugify,
    [
      [args: [input: ""], expected: ""],
      [args: [input: "!!!"], condition: "isEmpty", expected: never],
      [args: [input: "a"], expected: "a"],
      [args: [input: "A B C", maxLength: 3], expected: "a-b"],
    ]
  >;

  /** `maxLength` is a hard cap. */
  export type Length = Expect<
    Invoke<
      typeof slugify,
      ["a very long title that goes on and on and on and on and on and on", 16]
    >["length"],
    "<=",
    16
  >;

  export type Ordering = Expect<Invoke<typeof slugify, ["b"]>, ">", "a">;

  export type Unicode = Skip<
    Expect<Invoke<typeof slugify, ["日本語"]>, "isNotEmpty">,
    "transliteration not implemented"
  >;

  export type Emoji =
    Todo<"decide whether emoji should be stripped or transliterated">;
}

declare namespace Tests.truncate {
  export type Short = Expect<Invoke<typeof truncate, ["hi", 10]>, "=", "hi">;
  export type Long = Expect<
    Invoke<typeof truncate, ["hello world", 8]>,
    "=",
    "hello w…"
  >;
  export type CustomEllipsis = Expect<
    Invoke<typeof truncate, ["hello world", 8, "..."]>,
    "endsWith",
    "..."
  >;
  export type NeverLonger = Expect<
    Invoke<typeof truncate, ["hello world", 8]>["length"],
    "<=",
    8
  >;
}
