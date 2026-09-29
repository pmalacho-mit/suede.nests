import { explain } from "./failure.js";

import type { Assertion, Report } from "./vitest.js";

export type Outcome =
  | { state: "running" }
  | { state: "passed"; duration: number }
  | { state: "skipped" }
  | { state: "failed"; message: string; duration: number };

export const lensTitle = (outcome: Outcome | undefined) => {
  if (!outcome) return "$(play) Run";
  if (outcome.state === "running") return "$(sync~spin) Running…";
  if (outcome.state === "passed") return `$(check) Passed (${outcome.duration}ms)`;
  if (outcome.state === "skipped") return "$(circle-slash) Skipped";
  return "$(error) Failed";
};

const BETWEEN_FAILURES = `\n\n${"─".repeat(60)}\n\n`;

// with no library to ask, Vitest's own message is all there is: its first line, then frames
const explained = ({ details }: Report, assertion: Assertion) => {
  const detail = details.get(assertion.title);
  if (detail?.message) return explain({ name: assertion.title, ...detail });
  const [message = "failed", ...stack] = (
    assertion.failureMessages?.[0] ?? "failed"
  ).split("\n");
  return explain({ name: assertion.title, message, stack: stack.join("\n") });
};

export function outcomeOf(report: Report, assertions: Assertion[], duration: number): Outcome {
  const failed = assertions.filter((a) => a.status === "failed");
  if (failed.length) {
    const message = failed.map((a) => explained(report, a)).join(BETWEEN_FAILURES);
    return { state: "failed", message, duration };
  }
  if (assertions.every((a) => a.status === "passed")) return { state: "passed", duration };
  return { state: "skipped" };
}
