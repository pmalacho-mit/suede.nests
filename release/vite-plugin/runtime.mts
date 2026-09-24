import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";

export type DisplayValues = { actual: unknown; expected?: unknown; meta?: unknown };

export type DisplayRecord = {
  /** The display page, relative to the test file. */
  display: string;
  actual: unknown;
  expected: unknown;
  meta: unknown;
};

// `meta` is Vitest's `TaskMeta`: an empty interface for augmentation, so `object`.
export type TaskLike = { meta: object };

type Recording = { namespaceTests?: DisplayRecord[] };

const recording = (task: TaskLike) => task.meta as Recording;

export const recordedFor = (task: TaskLike) => recording(task).namespaceTests ?? [];

export function recordForDisplay(
  task: TaskLike,
  page: string,
  { actual, expected, meta }: DisplayValues,
): void {
  (recording(task).namespaceTests ??= []).push({
    display: page,
    actual,
    expected,
    meta: meta ?? null,
  });
}

declare namespace recordForDisplay {
  type Task = { meta: {} };

  export type Records = Expect<
    Invoke<typeof recordAndRead, [Task, "./page.html", { actual: [5, 1]; expected: [5, 2] }]>,
    "=",
    [{ display: "./page.html"; actual: [5, 1]; expected: [5, 2]; meta: null }]
  >;
}

const recordAndRead = (task: TaskLike, page: string, values: DisplayValues) => {
  recordForDisplay(task, page, values);
  return recordedFor(task);
};
