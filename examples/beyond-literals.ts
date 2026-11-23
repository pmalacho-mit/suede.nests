import fs from "node:fs";
import path from "node:path";

import type {
  AdvanceTimers,
  Call,
  Calls,
  Caught,
  Construct,
  Exists,
  Expect,
  FakeTimers,
  FromFile,
  Given,
  Invoke,
  ListDir,
  Repeat,
  Spy,
  StubEnv,
  Table,
  TempDir,
  Throws,
  WriteFile,
} from "../release/dsl.import.meta.vitest.ts";

// The cases examples/harnessed.ts needs a harness module for, said in the DSL
// instead, and a few more of the same kind: what a test of real code reaches
// for once its inputs stop being literals.

export const each = (xs: number[], visit: (x: number) => void) => {
  for (const x of xs) visit(x);
};

declare namespace each {
  type Visit = Spy<(x: number) => void>;

  /** each element is handed to the callback, in order, once */
  export type VisitsInOrder = Given<
    Invoke<typeof each, [xs: [1, 2, 3], visit: Visit]>,
    Expect<Calls<Visit>, "=", [[1], [2], [3]]>
  >;
}

export const debounce = (run: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
};

declare namespace debounce {
  type Run = Spy<() => void>;
  type Debounced = Invoke<typeof debounce, [run: Run, ms: 100]>;

  /** a burst of calls runs once, after the quiet period */
  export type CallsOnceAfterABurst = Given<
    [
      FakeTimers,
      Invoke<Debounced>,
      Invoke<Debounced>,
      Invoke<Debounced>,
      AdvanceTimers<100>,
    ],
    Expect<Calls<Run>["length"], "=", 1>
  >;

  /** and not before it */
  export type NotBefore = Given<
    [FakeTimers, Invoke<Debounced>, AdvanceTimers<99>],
    Expect<Calls<Run>, "isEmpty">
  >;
}

export const retrying = async (load: () => Promise<number>) => {
  try {
    return await load();
  } catch {
    return await load();
  }
};

declare namespace retrying {
  type Load = Spy<() => Promise<number>>;

  /** a load that fails once is tried again, and its second answer is the answer */
  export type RetriesOnce = Given<
    [
      Call<
        Load,
        "mockRejectedValueOnce",
        [error: Construct<typeof Error, [message: "flaky"]>]
      >,
      Call<Load, "mockResolvedValue", [value: 7]>,
    ],
    [
      Expect<Invoke<typeof retrying, [load: Load]>, "=", 7>,
      Expect<Calls<Load>["length"], "=", 2>,
    ]
  >;
}

/** A refusal: what went wrong, what to do instead, and the exit code a script sees. */
export class Refusal extends Error {
  readonly fix: string;
  readonly code: number;
  constructor(message: string, fix: string, code = 1) {
    super(message);
    this.fix = fix;
    this.code = code;
  }
}

/** A TCP port, from the text a person typed. */
export const parsePort = (text: string): number => {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Refusal(
      `'${text}' is not a port`,
      "a whole number from 1 to 65535",
      64,
    );
  return port;
};

declare namespace parsePort {
  type Refused = Caught<Invoke<typeof parsePort, [text: "http"]>, Refusal>;

  export type Reads = Table<
    typeof parsePort,
    [[args: [text: "8080"], expected: 8080], [args: [text: "1"], expected: 1]]
  >;

  /** a refusal says what to type instead, and exits as a usage error */
  export type SaysWhatToDo = Expect<
    Refused,
    "matches",
    {
      message: "'http' is not a port";
      fix: "a whole number from 1 to 65535";
      code: 64;
    }
  >;

  /** the same, said as a Throws matcher with the error's own fields */
  export type OutOfRange = Throws<
    Invoke<typeof parsePort, [text: "65536"]>,
    { instanceOf: Refusal; code: 64 }
  >;
}

/** Which backend the stack runs on: the person's setting, or qemu. */
export const backend = () => process.env.NESTS_EXAMPLE_BACKEND ?? "qemu";

declare namespace backend {
  /** the variable decides, for this test alone */
  export type Set = Given<
    StubEnv<"NESTS_EXAMPLE_BACKEND", "fake">,
    Expect<Invoke<typeof backend>, "=", "fake">
  >;

  /** unset, the default; and the test before did not leak into this one */
  export type Unset = Given<
    StubEnv<"NESTS_EXAMPLE_BACKEND", undefined>,
    Expect<Invoke<typeof backend>, "=", "qemu">
  >;
}

/** Copies a file, making the directories it goes into. */
export const copy = (from: string, to: string) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

declare namespace copy {
  type Dir = TempDir<{ "in/a.txt": "hello" }>;

  /** the copy has the original's text, and the original stays */
  export type Copies = Given<
    Invoke<typeof copy, [from: `${Dir}/in/a.txt`, to: `${Dir}/out/a.txt`]>,
    [
      Expect<FromFile<`${Dir}/out/a.txt`>, "=", "hello">,
      Expect<ListDir<Dir>, "=", ["in", "out"]>,
      Expect<Exists<`${Dir}/in/a.txt`>, "truthy">,
    ]
  >;

  /** a file changed after one copy is copied as it is now */
  export type CopiesAgain = Given<
    [
      Invoke<typeof copy, [from: `${Dir}/in/a.txt`, to: `${Dir}/out.txt`]>,
      WriteFile<`${Dir}/in/a.txt`, "changed">,
      Invoke<typeof copy, [from: `${Dir}/in/a.txt`, to: `${Dir}/out.txt`]>,
    ],
    Expect<FromFile<`${Dir}/out.txt`>, "=", "changed">
  >;
}

/** A branch name desolate would carry: at most 200 characters. */
export const isBranch = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && value.length <= 200;

declare namespace isBranch {
  /** at the bound, a branch; one past it, not */
  export type Bound = Table<
    typeof isBranch,
    [
      [args: [value: `b${Repeat<"x", 199>}`], expected: true],
      /** the control: the same shape, one character longer */
      [args: [value: `b${Repeat<"x", 200>}`], expected: false],
    ]
  >;
}
