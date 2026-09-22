import { test, expect } from "vitest";
import { encode, decode } from "../release/vite-plugin/codec.mts";

test("round-trips what JSON cannot", () => {
  const cyc: { a: number, self?: unknown } = { a: 1 };
  cyc.self = cyc;
  const v = {
    u: undefined, big: 10n, nan: NaN, inf: -Infinity, d: new Date(0), re: /a+/gi,
    bytes: new Uint8ClampedArray([1, 2, 255]), f64: new Float64Array([0.5]), m: new Map([["k", [1n]]]), s: new Set([1, "x"]),
    err: new RangeError("boom"), nested: [{ deep: [undefined] }],
  };
  const json = JSON.parse(JSON.stringify(encode(v)));
  const back = decode(json) as Record<keyof typeof v, any>;
  expect(back.u).toBeUndefined();
  expect(back.big).toBe(10n);
  expect(back.nan).toBeNaN();
  expect(back.inf).toBe(-Infinity);
  expect(back.d).toEqual(new Date(0));
  expect(back.re).toEqual(/a+/gi);
  expect(Array.from(back.bytes)).toEqual([1, 2, 255]);
  expect(back.bytes).toBeInstanceOf(Uint8ClampedArray);
  expect(Array.from(back.f64)).toEqual([0.5]);
  expect(back.m.get("k")).toEqual([1n]);
  expect(back.s.has("x")).toBe(true);
  expect(back.err).toBeInstanceOf(Error);
  expect(back.err.message).toBe("boom");
  expect(back.nested[0].deep[0]).toBeUndefined();
  expect(encode(cyc)).toEqual({ a: 1, self: { $ref: "$" } });
});

test("records class names without trying to reconstruct instances", () => {
  class User { id: number; constructor() { this.id = 1; } }
  expect(encode(new User())).toEqual({ $class: "User", id: 1 });
});
