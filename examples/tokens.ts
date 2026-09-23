import type {
  Expect,
  Invoke,
  Table,
} from "../release/dsl.import.meta.vitest.ts";
import ts from "typescript";

/** Top-level statements in a snippet of TypeScript. */
export const statementCount = (source: string) =>
  ts.createSourceFile("snippet.ts", source, ts.ScriptTarget.ES2022, true)
    .statements.length;

declare namespace statementCount {
  /** a package import is shared, not copied, so this is the real TypeScript */
  export type Counts = Table<
    typeof statementCount,
    [
      [args: [source: "const a = 1;"], expect: 1],
      [args: [source: "const a = 1;\nconst b = 2;"], expect: 2],
      [args: [source: ""], expect: 0],
    ]
  >;
}

/** The kind of the first statement, as TypeScript names it. */
export function firstStatementKind(source: string): string {
  const file = ts.createSourceFile(
    "snippet.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const first = file.statements[0];
  return first ? ts.SyntaxKind[first.kind] : "None";
}

declare namespace firstStatementKind {
  export type Kind = Expect<
    Invoke<typeof firstStatementKind, ["class A {}"]>,
    "=",
    "ClassDeclaration"
  >;
}
