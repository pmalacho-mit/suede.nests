import { onTestFinished, vi } from "vitest";

import { debounce, each, retrying } from "../harnessed.ts";

export const callsOf = (xs: number[]) => {
  const visit = vi.fn();
  each(xs, visit);
  return visit.mock.calls;
};

export const debounced = (calls: number) => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  const run = vi.fn();
  const call = debounce(run, 100);
  for (let i = 0; i < calls; i++) call();
  vi.advanceTimersByTime(100);
  return run.mock.calls.length;
};

export const fetchedTwice = async () => {
  let attempts = 0;
  const value = await retrying(async () => {
    attempts++;
    if (attempts === 1) throw new Error("flaky");
    return 7;
  });
  return { value, attempts };
};

export const fakeRates = { exchangeRate: () => 2, symbol: () => "€" };

export const keepingTheRest = async (importOriginal: () => Promise<typeof import("./rates.ts")>) => ({
  ...(await importOriginal()),
  exchangeRate: () => 4,
});
