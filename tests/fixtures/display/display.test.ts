import { expect, recordArtifact, test } from "vitest";

import { encode } from "../../../release/vite-plugin/codec.mts";

class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

test("rich values", async ({ task }) => {
  await recordArtifact(task, {
    type: "namespace-tests:display",
    page: "./page.html",
    actual: encode({ counts: new Map([["a", 1n]]), point: new Point(1), bytes: new Uint8Array([1, 2]) }),
    expected: encode([1, 2]),
    meta: encode({ bins: 4 }),
  });
  expect(1).toBe(1);
});

test("a function", async ({ task }) => {
  await recordArtifact(task, { type: "namespace-tests:display", page: "./page.html", actual: encode(() => 1) });
  expect(1).toBe(1);
});
