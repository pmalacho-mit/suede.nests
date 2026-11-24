// Runs TypeDoc with release/describe/typedoc.mts on a small module, and reads
// what it made: the tests gone from the output, and the claims on the page of
// the function they are about.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { Application, ReflectionKind, TSConfigReader } from "typedoc";

import { repoRoot } from "./helpers.mts";

import type {
  DeclarationReflection,
  InlineTagDisplayPart,
  ProjectReflection,
} from "typedoc";

const fixture = path.join(repoRoot, "tests/fixtures/typedoc");
const plugin = path.join(repoRoot, "release/describe/typedoc.mts");

let project: ProjectReflection;
let page = "";
const warnings: string[] = [];

beforeAll(async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nests-typedoc-"));
  // only the tsconfig is read: the repository's own typedoc.json is not this run's
  const app = await Application.bootstrapWithPlugins(
    {
      entryPoints: [path.join(fixture, "memory.ts")],
      out,
      tsconfig: path.join(fixture, "tsconfig.json"),
      plugin: ["typedoc-plugin-markdown", plugin],
      readme: "none",
      disableSources: true,
      name: "fixture",
    },
    [new TSConfigReader()],
  );
  app.logger.warn = (message: string) => void warnings.push(message);
  const converted = await app.convert();
  if (!converted) throw new Error("TypeDoc converted nothing");
  project = converted;
  try {
    await app.generateOutputs(project);
    page = fs.readFileSync(path.join(out, "functions/parseMemory.md"), "utf8");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}, 120_000);

const functionNamed = (name: string) =>
  project
    .getReflectionsByKind(ReflectionKind.Function)
    .find((r) => r.name === name) as DeclarationReflection;

const claimsOf = (name: string) =>
  functionNamed(name)
    .signatures![0]!.comment!.blockTags.filter((t) => t.tag === "@claims")
    .map((t) => t.content.map((p) => p.text).join(""))
    .join("");

test("the tests are not in the output: no type alias, and no namespace an exported one would have had", () => {
  expect(
    project.getReflectionsByKind(ReflectionKind.TypeAlias).map((r) => r.name),
  ).toEqual([]);
  expect(
    project.getReflectionsByKind(ReflectionKind.Namespace).map((r) => r.name),
  ).toEqual([]);
});

test("a function's claims are on its own page, split into what it answers and what it refuses", () => {
  const claims = claimsOf("parseMemory");
  expect(claims).toContain("**What it answers**");
  expect(claims).toContain(
    '<a id="claim-Spellings"></a>**Spellings**: suffixes are read',
  );
  expect(claims).toContain('| `"8g"` | `8192` |');
  expect(claims).toContain("**What it refuses**");
  expect(claims).toContain(
    '**Junk**: anything else is not memory\n  - `parseMemory("lots") → null`',
  );
  expect(claimsOf("double")).toContain("**Two**: two is four");
});

test("a link to a claim goes to it: on the same page by its anchor, from elsewhere to the function", () => {
  const links = (name: string) =>
    functionNamed(name).signatures![0]!.comment!.summary.filter(
      (p): p is InlineTagDisplayPart => p.kind === "inline-tag",
    );
  expect(links("parseMemory").map((l) => [l.text, l.target])).toEqual([
    ["read", "#claim-Spellings"],
    ["parseMemory.Junk", "#claim-Junk"],
  ]);
  expect(links("double")[0]?.target).toBe(functionNamed("parseMemory"));
});

test("nothing is warned about: the links resolve, though the tests they name are gone", () => {
  expect(warnings).toEqual([]);
});

test("the page reads as Markdown, the claims under their own heading", () => {
  expect(page).toContain("## Claims");
  expect(page).toContain('"8g" is [read](#claim-Spellings)');
});
