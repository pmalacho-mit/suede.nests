import { test, expect } from "vitest";
import { encodeMappings, decodeMappings, originalPositionFor } from "../release/vite-plugin/sourcemap.mts";

import type { Segment } from "../release/vite-plugin/sourcemap.mts";

test("round-trips segments, including negative deltas, large values and empty lines", () => {
  const lines: Segment[][] = [
    [[0, 0, 0, 0]],
    [],
    [[4, 0, 41, 0], [12, 0, 2, 7]], // backwards line delta
    [[0, 0, 100000, 65535]], // multi-char VLQs
    [[2, 1, 0, 0]], // second source
  ];
  const encoded = encodeMappings(lines);
  expect(encoded).toBe("AAAA;;IAyCA,QAvCO;AA8pjGw//D;EChqjG///D"); // verified once against @jridgewell/sourcemap-codec
  expect(decodeMappings(encoded)).toEqual(lines);
});

test("matches the spec's worked example", () => {
  // From the Source Map spec: "AAgBC" = [0, 0, 16, 1]
  expect(decodeMappings("AAgBC")).toEqual([[[0, 0, 16, 1]]]);
  expect(encodeMappings([[[0, 0, 16, 1]]])).toBe("AAgBC");
});

test("originalPositionFor picks the last segment at or before the column", () => {
  const lines = decodeMappings(encodeMappings([[[0, 0, 5, 0], [10, 0, 7, 3]]]));
  expect(originalPositionFor(lines, 0, 9)).toEqual({ line: 5, column: 0 });
  expect(originalPositionFor(lines, 0, 10)).toEqual({ line: 7, column: 3 });
  expect(originalPositionFor(lines, 1, 0)).toBeNull();
});
