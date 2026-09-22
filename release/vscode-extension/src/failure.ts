// What a failing test says, put together from what the run reported: the
// assertion's own message, the diff of what it expected against what it got,
// and where to look. Kept away from the editor so it can be tested on its own.
import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";

/** What a run reported about one failure. */
export type Failure = {
  /** The test's name, as it was written. */
  name: string;
  /** The assertion's own message. */
  message: string;
  /** Expected against received, as the runner printed it. */
  diff?: string | null;
  /** Where the run said it happened, relative to the workspace. */
  where?: string | null;
  /** The frames the runner gave, if any. */
  stack?: string | null;
};

/** The generated test the plugin serves from memory — no such file on disk. */
const VIRTUAL = ".namespace.test.ts";

/**
 * A stack with the runner's own machinery taken out, and with it the frames
 * pointing into the generated test: that module is served from memory, so its
 * path opens nothing. What is left is your code, which is the part worth
 * reading — and the failure says where it was written anyway.
 */
export function frames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .filter(
      (line) =>
        !line.includes("node_modules") &&
        !line.includes("node:internal") &&
        !line.includes("(native)") &&
        !line.includes(VIRTUAL),
    );
}

/** One failure, as it reads in the output channel. */
export function explain(failure: Failure): string {
  const { name, message, diff, where, stack } = failure;
  const parts = [where ? `${name} — ${where}` : name, "", message];
  if (diff) parts.push("", diff.replace(/\s+$/, ""));
  const rest = frames(stack);
  if (rest.length) parts.push("", ...rest);
  return parts.join("\n");
}

declare namespace Tests.frames {
  type Stack = `AssertionError: nope
    at Proxy.<anonymous> (/repo/node_modules/vitest/dist/chunks/index.js:2040:10)
    at /repo/examples/parser.parse_Negation.namespace.test.ts:75:29
    at processTicksAndRejections (node:internal/process/task_queues:104:5)`;

  type Thrown = `RangeError: initial must be an integer
    at new Counter (/repo/examples/counter.ts:12:13)
    at /repo/examples/counter.Counter_Rejects.namespace.test.ts:30:5
    at processTicksAndRejections (node:internal/process/task_queues:104:5)`;

  /** your code is what is left: the runner's frames and the generated one go */
  export type Yours = Expect<
    Invoke<typeof frames, [Thrown]>,
    "=",
    ["at new Counter (/repo/examples/counter.ts:12:13)"]
  >;

  /** a failure inside the generated test alone has no frame worth showing */
  export type NothingToOpen = Expect<Invoke<typeof frames, [Stack]>, "=", []>;

  export type Missing = Table<
    typeof frames,
    [[args: [null], expected: []], [args: [""], expected: []]]
  >;
}

declare namespace Tests.explain {
  /** the message, then what it expected against what it got, then where */
  export type WithDiff = Expect<
    Invoke<
      typeof explain,
      [
        {
          name: "parse > Negation";
          message: "expected { kind: 'neg' } to match object { kind: 'neg' }";
          diff: "- Expected\n+ Received\n\n-   4\n+   5\n";
          where: "examples/parser.ts:37";
        },
      ]
    >,
    "=",
    `parse > Negation — examples/parser.ts:37

expected { kind: 'neg' } to match object { kind: 'neg' }

- Expected
+ Received

-   4
+   5`
  >;

  /** with nothing to diff — a printer error, say — just the message */
  export type WithoutDiff = Expect<
    Invoke<
      typeof explain,
      [{ name: "wrong > NotAValue"; message: "cannot materialize" }]
    >,
    "=",
    "wrong > NotAValue\n\ncannot materialize"
  >;
}
