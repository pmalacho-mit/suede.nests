// The minimal-reproduction printer reads the emitted tests directly, so this
// pins down that it still finds a test and de-indents its body.
import { test, expect } from "vitest";
import { minimalFor } from "../release/vite-plugin/minimal.mts";

test("prints one test as an ordinary Vitest file, pruned to what it needs", () => {
  const src = minimalFor("examples/counter.ts", "Reset");
  // imports first, then the code the test needs, then the test itself
  expect(src.startsWith('import { test, expect } from "vitest";')).toBe(true);
  // nothing in this test awaits, so it is an ordinary synchronous test
  expect(src).toContain('test("Tests > Counter > Reset", () => {');
  // the test body, de-indented and with the class it exercises kept
  expect(src).toContain("class Counter");
  expect(src.trimEnd().endsWith("});")).toBe(true);
  // the parts of the module the test does not touch are pruned away
  expect(src).not.toContain("declare namespace Tests");
  expect(src).not.toContain("describe(");
});

test("finds a test by its full name as well as its alias", () => {
  // the same test either way, named after itself rather than after the lookup
  expect(minimalFor("examples/counter.ts", "Tests > Counter > Reset")).toBe(
    minimalFor("examples/counter.ts", "Reset"),
  );
});

test("says so when the test does not exist", () => {
  expect(() => minimalFor("examples/counter.ts", "Nope")).toThrow(
    /no test named Nope/,
  );
});
