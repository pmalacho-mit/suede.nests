// Runtime helpers imported by generated code for assertions that have a display
// page. Runs the same matcher the printer would have emitted, but records the
// raw actual/expected values on `task.meta` so the reporter can hand them to
// the IDE's display page. Everything else in generated code is plain `expect`.

/** A display record: what the IDE's display page receives (after the reporter encodes it). */
export type DisplayRecord = {
  /** Path of the display page, relative to the test file. */
  display: string;
  /** `Config.displayMeta`, or null. */
  meta: unknown;
  /** The matcher chain that was applied, e.g. `.toEqual(expected)`. */
  condition: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  /** The assertion error message when it failed. */
  message: string | null;
};

/**
 * Minimal view of Vitest's task context that ntCheck touches. `meta` is Vitest's
 * `TaskMeta`, an empty augmentable interface, so it is accepted as `object` and
 * narrowed inside (an all-optional shape would fail TS's weak-type check).
 */
export type TaskLike = { meta: object, result?: { errors?: unknown[] | undefined } | undefined };

/**
 * @param task The test's `task` (from `test(name, async ({ task }) => …)`).
 * @param matcher Runs the `expect` chain; throws on failure.
 */
export async function ntCheck<T>(
  task: TaskLike,
  { display, meta, soft }: { display: string, meta?: unknown, soft: boolean },
  actualThunk: () => T | Promise<T>,
  expected: unknown,
  matcher: (actual: Awaited<T>) => unknown,
): Promise<void> {
  const actual = await actualThunk();
  const record: DisplayRecord = {
    display,
    meta: meta ?? null,
    condition: matcher.toString().replace(/^\(actual\) => expect(\.soft)?\(actual\)/, ""),
    passed: true,
    actual,
    expected,
    message: null,
  };
  const taskMeta = task.meta as { namespaceTests?: DisplayRecord[] };
  (taskMeta.namespaceTests ??= []).push(record);
  try {
    matcher(actual);
  } catch (err) {
    record.passed = false;
    record.message = err instanceof Error ? err.message : String(err);
    if (soft) task.result?.errors?.push(err); // best effort; soft expectations continue
    else throw err;
  }
}

