import type { Expect, Invoke } from "../release/dsl.import.meta.vitest.ts";
import type { callsOf, debounced, fetchedTwice } from "./lib/harness.ts";

export const each = (xs: number[], visit: (x: number) => void) => {
  for (const x of xs) visit(x);
};

export const debounce = (run: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
};

export const retrying = async (load: () => Promise<number>) => {
  try {
    return await load();
  } catch {
    return await load();
  }
};

declare namespace each {
  /** a callback, observed through a spy the harness makes */
  export type VisitsInOrder = Expect<Invoke<typeof callsOf, [[1, 2, 3]]>, "=", [[1], [2], [3]]>;
}

declare namespace debounce {
  /** fake timers, put back by the harness when the test finishes */
  export type CallsOnceAfterABurst = Expect<Invoke<typeof debounced, [3]>, "=", 1>;
}

declare namespace retrying {
  /** async orchestration: a load that fails once, then succeeds */
  export type RetriesOnce = Expect<Invoke<typeof fetchedTwice>, "=", { value: 7; attempts: 2 }>;
}
