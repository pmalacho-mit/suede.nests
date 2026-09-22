// A forked module hands its own imports the same tag, so one test's copy of a
// module reaches its own copy of everything first-party below it. The
// specifiers come from `es-module-lexer`, so these pin down which spans it
// rewrites — and, just as much, which text it must not touch.
import { test, expect } from "vitest";
import path from "node:path";
import plugin from "../release/vite-plugin/plugin.mts";
import { repoRoot } from "./helpers.mts";

import type { Plugin } from "vitest/config";

/** Run the plugin's transform over `code` as a module already forked as `T`. */
const forked = async (code: string) => {
  const p = plugin({ scan: false });
  const hook = typeof p.transform === "function" ? p.transform : p.transform?.handler;
  if (!hook) throw new Error("plugin has no transform hook");
  const ctx = { warn() {} } as unknown as ThisParameterType<Extract<NonNullable<Plugin["transform"]>, Function>>;
  const id = `${path.join(repoRoot, "examples/counter.ts")}?namespace-test=T`;
  const result = await hook.call(ctx, code, id, undefined);
  if (!result || typeof result === "string") throw new Error("no transform result");
  return result.code;
};

test("tags every kind of first-party import, and nothing else", async () => {
  const code = [
    `import a from "./a.ts";`,
    `import type { T } from "./t.ts";`,
    `export { b } from "./b.ts";`,
    `export * from "./d.ts";`,
    `import pkg from "vitest";`,
    `const e = await import("./e.ts");`,
    `const q = await import("./q.ts?raw");`,
  ].join("\n");
  expect(await forked(code)).toBe(
    [
      `import a from "./a.ts?namespace-test=T";`,
      `import type { T } from "./t.ts?namespace-test=T";`,
      `export { b } from "./b.ts?namespace-test=T";`,
      `export * from "./d.ts?namespace-test=T";`,
      // a package is left alone: Vitest hands it to Node, which knows nothing
      // of the query this forks with
      `import pkg from "vitest";`,
      `const e = await import("./e.ts?namespace-test=T");`,
      // a specifier that already carries a query gets another parameter
      `const q = await import("./q.ts?raw&namespace-test=T");`,
    ].join("\n"),
  );
});

test("leaves a string that merely looks like an import alone", async () => {
  const code = [
    `const snippet = 'import x from "./x.ts";';`,
    `const spec = "./y.ts";`,
    `const dynamic = await import(spec);`,
  ].join("\n");
  expect(await forked(code)).toBe(code);
});
