// Source Map v3 "mappings" encoding and decoding (Base64 VLQ).
// Spec: https://tc39.es/ecma426/
//
// A segment is [generatedColumn, sourceIndex, originalLine, originalColumn],
// all 0-based. Lines are arrays of segments; the array index is the generated line.

export type Segment = [generatedColumn: number, sourceIndex: number, originalLine: number, originalColumn: number];

import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const INDEX = new Map<string, number>([...CHARS].map((c, i) => [c, i]));

/** Encode one integer as Base64 VLQ: sign in the low bit, 5 data bits per char, continuation in bit 5. */
function vlq(n: number) {
  let value = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = value & 0b11111;
    value >>>= 5;
    if (value > 0) digit |= 0b100000;
    out += CHARS[digit];
  } while (value > 0);
  return out;
}

/**
 * Encode lines of segments into a "mappings" string. Fields are delta-encoded
 * per the spec: generated column resets each line; the other three carry across lines.
 */
export function encodeMappings(lines: readonly (readonly Segment[])[]): string {
  let prevSource = 0, prevLine = 0, prevColumn = 0;
  return lines
    .map((segments) => {
      let prevGen = 0;
      return segments
        .map(([gen, source, line, column]) => {
          const s = vlq(gen - prevGen) + vlq(source - prevSource) + vlq(line - prevLine) + vlq(column - prevColumn);
          prevGen = gen; prevSource = source; prevLine = line; prevColumn = column;
          return s;
        })
        .join(",");
    })
    .join(";");
}

declare namespace Tests.encodeMappings {
  /** the spec's worked example: one segment, [0, 0, 16, 1] */
  export type SpecExample = Expect<
    Invoke<typeof encodeMappings, [[[[0, 0, 16, 1]]]]>,
    "=",
    "AAgBC"
  >;

  /** an empty generated line contributes nothing between the semicolons */
  export type EmptyLine = Expect<
    Invoke<typeof encodeMappings, [[[[0, 0, 0, 0]], [], [[2, 0, 1, 0]]]]>,
    "=",
    "AAAA;;EACA"
  >;
}


/** Inverse of `encodeMappings`. Segments with 1 field (unmapped) are dropped; 5-field segments (names) keep the first 4. */
export function decodeMappings(mappings: string): Segment[][] {
  let source = 0, line = 0, column = 0;
  return mappings.split(";").map((lineText) => {
    let gen = 0;
    const segments: Segment[] = [];
    for (const segText of lineText.split(",")) {
      if (!segText) continue;
      const fields: number[] = [];
      let value = 0, shift = 0;
      for (const c of segText) {
        const digit = INDEX.get(c);
        if (digit === undefined) throw new Error(`invalid VLQ character ${JSON.stringify(c)}`);
        value += (digit & 0b11111) << shift;
        if (digit & 0b100000) shift += 5;
        else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0; shift = 0;
        }
      }
      const [dGen = 0, dSource, dLine, dColumn] = fields;
      gen += dGen;
      if (dSource === undefined || dLine === undefined || dColumn === undefined) continue;
      source += dSource; line += dLine; column += dColumn;
      segments.push([gen, source, line, column]);
    }
    return segments;
  });
}

declare namespace Tests.decodeMappings {
  /** decoding is the inverse of encoding */
  export type SpecExample = Expect<
    Invoke<typeof decodeMappings, ["AAgBC"]>,
    "=",
    [[[0, 0, 16, 1]]]
  >;

  /** every field but the generated column carries across lines, and may go backwards */
  export type Deltas = Expect<
    Invoke<typeof decodeMappings, ["AAAA;;IAyCA,QAvCO"]>,
    "=",
    [[[0, 0, 0, 0]], [], [[4, 0, 41, 0], [12, 0, 2, 7]]]
  >;
}


/**
 * The original line/column for a generated position (the last segment at or before `column`), like a source-map consumer.
 * @param lines Decoded mappings.
 * @param generatedLine 0-based
 * @param generatedColumn 0-based
 */
export function originalPositionFor(
  lines: readonly (readonly Segment[])[],
  generatedLine: number,
  generatedColumn: number,
): { line: number, column: number } | null {
  const segments = lines[generatedLine] ?? [];
  let best: Segment | null = null;
  for (const s of segments) if (s[0] <= generatedColumn) best = s;
  return best ? { line: best[2], column: best[3] } : null;
}

declare namespace Tests.originalPositionFor {
  type Line = [[[0, 0, 5, 0], [10, 0, 7, 3]]];

  /** the last segment at or before the column wins */
  export type Lookup = Table<
    typeof originalPositionFor,
    [
      [args: [lines: Line, line: 0, column: 0], expected: { line: 5; column: 0 }],
      [args: [lines: Line, line: 0, column: 9], expected: { line: 5; column: 0 }],
      [args: [lines: Line, line: 0, column: 10], expected: { line: 7; column: 3 }],
      [args: [lines: Line, line: 1, column: 0], expected: null]
    ]
  >;
}

