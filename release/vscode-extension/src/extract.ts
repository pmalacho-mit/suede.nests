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

/** Everything below the two header lines and the blank line after them. */
const bodyOf = (text: string) => text.split("\n").slice(3).join("\n");

/**
 * The extracted file: a header saying where it came from, then the test. The
 * header carries the body's fingerprint, which is how deleting one later can
 * tell an untouched file from one that has been worked on.
 */
export function extract(
  source: string,
  testName: string,
  body: string,
): string {
  return [
    `// ${MARK} ${source} > ${JSON.stringify(testName)} [${fingerprint(body)}]`,
    `// Yours to run, debug and edit. Delete it when you are done.`,
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

declare namespace Tests.tempPathFor {
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

declare namespace Tests.extracted {
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

  /** the same file, with something added to the body someone was given */
  type Worked = Call<File, "concat", ["expect(1).toBe(1);\n"]>;

  /** a body that no longer matches its fingerprint is one someone worked on */
  export type Edited = Expect<
    Invoke<typeof extracted, [Worked]>,
    "matches",
    { edited: true }
  >;

  /** anything else is just a file */
  export type NotOurs = Expect<
    Invoke<typeof extracted, ["const x = 1;"]>,
    "is",
    null
  >;
}
