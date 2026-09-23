// Extracting a test: the generated test, written to a real file beside the
// module it came from, so it can be run and debugged like any other test file.
// The naming, the header and the "has this been edited" check live here, away
// from the editor, so they can be tested on their own.
import { createHash } from "node:crypto";
import path from "node:path";

import type { Call, Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";

/** What an extracted file is called, and what it is called that for. */
export const SUFFIX = ".temp.ts";

const MARK = "namespace-tests:";

/**
 * The file a test extracts to: beside the module it was written in, named for
 * that module and the test, so several extracted tests can sit side by side.
 *
 * `counter.ts` + `Counter > Chainable` → `counter.Counter_Chainable.temp.ts`
 */
export function tempPathFor(source: string, testName: string): string {
  const stem = path.basename(source).replace(/\.[cm]?tsx?$/, "");
  const name = testName.replace(/[^\w[\]-]+/g, "_").replace(/^_+|_+$/g, "");
  return path.join(path.dirname(source), `${stem}.${name}${SUFFIX}`);
}

/** One trailing newline, however the body arrived. */
const normalize = (body: string) => body.replace(/\s*$/, "\n");

/** The fingerprint of an extracted body, so an edit to it can be noticed. */
const fingerprint = (body: string) =>
  createHash("sha256").update(normalize(body)).digest("hex").slice(0, 12);

/** Everything below the header lines and the blank line after them. */
const bodyOf = (text: string) =>
  text.split("\n").slice(text.split("\n").indexOf("") + 1).join("\n");

/**
 * The extracted file: a header saying where it came from, then the test. The
 * header carries the body's fingerprint, which is how deleting one later can
 * tell an untouched file from one that has been worked on.
 */
/**
 * A run gives every test its own copy of the modules its subject reaches, so
 * state cannot cross from one test to the next. A file holds one module, so
 * several tests in one extract share what they import — which changes what they
 * see, and is worth saying where it is true.
 */
const sharesImports = (body: string) =>
  (body.match(/^test[.(]/gm) ?? []).length > 1 &&
  /^import .*from ["']\./m.test(body);

export function extract(
  source: string,
  testName: string,
  body: string,
): string {
  return [
    `// ${MARK} ${source} > ${JSON.stringify(testName)} [${fingerprint(body)}]`,
    `// Yours to run, debug and edit. Delete it when you are done.`,
    ...(sharesImports(body)
      ? ["// These tests share what they import; a run gives each its own copy."]
      : []),
    "",
    normalize(body),
  ].join("\n");
}

/** What an extracted file says about itself, or `null` if it is not one. */
export function extracted(text: string): {
  source: string;
  test: string;
  edited: boolean;
} | null {
  const [header] = text.split("\n");
  const match = new RegExp(
    `^// ${MARK} (.+?) > ("(?:[^"\\\\]|\\\\.)*") \\[([0-9a-f]+)\\]$`,
  ).exec(header ?? "");
  if (!match) return null;
  const [source = "", quoted = '""', hash = ""] = match.slice(1);
  return {
    source,
    test: JSON.parse(quoted) as string,
    edited: fingerprint(bodyOf(text)) !== hash,
  };
}

declare namespace tempPathFor {
  /** beside the module, named for the module and the test */
  export type Names = Table<
    typeof tempPathFor,
    [
      [
        args: [source: "src/counter.ts", test: "Counter > Chainable"],
        expected: "src/counter.Counter_Chainable.temp.ts",
      ],
      [
        args: [source: "src/codec.mts", test: "encode > Tagged[1]"],
        expected: "src/codec.encode_Tagged[1].temp.ts",
      ],
    ]
  >;
}

declare namespace extracted {
  type Body = "test('x', () => {});";
  type File = Invoke<
    typeof extract,
    ["src/counter.ts", "Counter > Chainable", Body]
  >;

  /** an extracted file knows the module and the test it came from */
  export type Origin = Expect<
    Invoke<typeof extracted, [File]>,
    "matches",
    { source: "src/counter.ts"; test: "Counter > Chainable"; edited: false }
  >;

  /** the same file, with a body that is no longer the one it was written with */
  type Worked = Call<
    File,
    "replace",
    [Body, "test('x', () => { expect(1).toBe(1); });"]
  >;

  /** a body that no longer matches its fingerprint is one someone worked on */
  export type Edited = Expect<
    Invoke<typeof extracted, [Worked]>,
    "matches",
    { edited: true }
  >;

  /** several tests in one file share what they import, and it says so */
  export type Warns = Expect<
    Invoke<
      typeof extract,
      [
        "src/a.ts",
        "a > Rows",
        'import { f } from "./m.ts";\ntest("one", () => {});\ntest("two", () => {});'
      ]
    >,
    "includes",
    "These tests share what they import"
  >;

  /** one test has nothing to share with, so it is not told about it */
  export type Quiet = Expect<
    Invoke<
      typeof extract,
      ["src/a.ts", "a > One", 'import { f } from "./m.ts";\ntest("one", () => {});']
    >,
    "excludes",
    "share what they import"
  >;

  /** nor is a file whose tests import nothing of yours */
  export type NoImports = Expect<
    Invoke<
      typeof extract,
      ["src/a.ts", "a > Rows", 'test("one", () => {});\ntest("two", () => {});']
    >,
    "excludes",
    "share what they import"
  >;

  /** anything else is just a file */
  export type NotOurs = Expect<
    Invoke<typeof extracted, ["const x = 1;"]>,
    "is",
    null
  >;
}
