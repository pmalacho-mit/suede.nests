// release/templates/optional/nests.d.ts stands in for the DSL where nests is not
// installed. These tests hold it to the real DSL: it must export everything the
// DSL does, accept every example that uses the DSL, and give way to the real
// module wherever that resolves.
import { describe, it, expect } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stubFile = path.join(root, "release/templates/optional/nests.d.ts");
const realFile = path.join(root, "release/dsl.import.meta.vitest.ts");
const examplesDir = path.join(root, "examples");
const probeFile = path.join(root, "release/__stub-probe__.ts");

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: ["node"],
};

/** Type-check `virtual` (path -> source) over the real disk; returns errors per file. */
const check = (
  virtual: Record<string, string>,
  rootNames: string[],
): Map<string, string[]> => {
  const host = ts.createCompilerHost(options);
  const { readFile, getSourceFile, fileExists } = host;
  host.fileExists = (f) => f in virtual || fileExists.call(host, f);
  host.readFile = (f) => virtual[f] ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, ...rest) =>
    f in virtual
      ? ts.createSourceFile(f, virtual[f], lang, true)
      : getSourceFile.call(host, f, lang, ...rest);
  const program = ts.createProgram(rootNames, options, host);
  const out = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file || d.category !== ts.DiagnosticCategory.Error) continue;
    const list = out.get(d.file.fileName) ?? [];
    list.push(
      `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
    out.set(d.file.fileName, list);
  }
  return out;
};

const exportedNames = (file: string, source: string) => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      ts.getCombinedModifierFlags(node as ts.Declaration) &
        ts.ModifierFlags.Export
    ) {
      if (ts.isVariableStatement(node))
        node.declarationList.declarations.forEach((d) =>
          names.add(d.name.getText()),
        );
      else names.add((node as any).name.getText());
    }
  };
  sf.forEachChild(visit);
  return names;
};

describe("optional-dependency stub", () => {
  const stub = fs.readFileSync(stubFile, "utf8");
  const stubModules = (() => {
    const sf = ts.createSourceFile(stubFile, stub, ts.ScriptTarget.ESNext, true);
    const modules = new Map<string, Set<string>>();
    sf.forEachChild((node) => {
      if (!ts.isModuleDeclaration(node)) return;
      const body = node.body as ts.ModuleBlock;
      modules.set(
        (node.name as ts.StringLiteral).text,
        exportedNames(stubFile, body.getText().slice(1, -1)),
      );
    });
    return modules;
  })();

  it("declares both spellings of the DSL import", () => {
    expect([...stubModules.keys()].sort()).toEqual([
      "*/dsl.import.meta.vitest",
      "*/dsl.import.meta.vitest.ts",
    ]);
  });

  it("exports everything the DSL exports", () => {
    const real = exportedNames(realFile, fs.readFileSync(realFile, "utf8"));
    expect(real.size).toBeGreaterThan(10);
    for (const [name, exported] of stubModules) {
      const missing = [...real].filter((n) => !exported.has(n));
      expect(missing, `missing from "${name}"`).toEqual([]);
    }
  });

  const spellings = [
    "./absent/dsl.import.meta.vitest",
    "./absent/dsl.import.meta.vitest.ts",
    "../../deep/absent/dsl.import.meta.vitest",
  ];

  const examples = fs
    .readdirSync(examplesDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(examplesDir, f));

  for (const example of examples) {
    it(`type-checks ${path.basename(example)} with the DSL absent`, () => {
      const source = fs
        .readFileSync(example, "utf8")
        .replaceAll(
          /(["'])(?:\.\.\/)+release\/dsl\.import\.meta\.vitest(?:\.ts)?\1/g,
          (_, q) => `${q}${spellings[0]}${q}`,
        );
      expect(source).not.toContain("release/dsl.import");

      const without = check({ [example]: source }, [example]);
      expect(without.get(example)?.some((e) => e.startsWith("TS2307"))).toBe(
        true,
      );

      const withStub = check({ [example]: source }, [example, stubFile]);
      // The stub is loose by design, so the `@ts-expect-error` lines that
      // examples use to show the real DSL rejecting something go unused.
      const errors = (withStub.get(example) ?? []).filter(
        (e) => !e.startsWith("TS2578"),
      );
      expect(errors).toEqual([]);
    });
  }

  it("accepts every spelling of the import", () => {
    const source =
      spellings
        .map((s, i) => `import type { Expect as E${i} } from "${s}";`)
        .join("\n") + "\nexport type X = E0<1, '=', 1> | E1<1> | E2<1>;\n";
    const result = check({ [probeFile]: source }, [probeFile, stubFile]);
    expect(result.get(probeFile) ?? []).toEqual([]);
  });

  it("gives way to the real DSL where it resolves", () => {
    // beside the real DSL, `./dsl.import.meta.vitest` resolves to it, so a
    // wrong expectation must still be an error even with the stub loaded
    const source = `import type { Expect } from "./dsl.import.meta.vitest";
export type Wrong = Expect<1, "startsWith", "x">;
`;
    const result = check({ [probeFile]: source }, [probeFile, stubFile]);
    expect(result.get(probeFile)?.length).toBeGreaterThan(0);
  });
});
