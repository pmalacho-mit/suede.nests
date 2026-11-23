// A module's top-level declarations, and the words written on them: what the
// printer prunes a module by, and what the docs read a function's prose from.
import ts from "@typescript/typescript6";

import type { Tag } from "./ir.mts";

/** The statement a declaration is written in: a `const`'s statement holds its JSDoc and its `export`. */
export const holderOf = (node: ts.Node): ts.Node =>
  ts.isVariableDeclaration(node) ? node.parent.parent : node;

/** The top-level statement a node is inside, or undefined when it is the file itself. */
export const statementOf = (
  sf: ts.SourceFile,
  node: ts.Node,
): ts.Statement | undefined => {
  let current: ts.Node = node;
  while (current.parent && current.parent !== sf) current = current.parent;
  return current.parent === sf ? (current as ts.Statement) : undefined;
};

export type TopLevel = { declaration: ts.Declaration; statement: ts.Statement };

/** Every value a module declares at its top: functions, classes, and each `const`/`let`. */
export function topLevelDeclarations(sf: ts.SourceFile): Map<string, TopLevel> {
  const byName = new Map<string, TopLevel>();
  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    )
      byName.set(statement.name.text, { declaration: statement, statement });
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          byName.set(declaration.name.text, { declaration, statement });
  }
  return byName;
}

/** A function declaration, or a `const` bound to an arrow or a function expression. */
export const isFunctionLike = (d: ts.Declaration) =>
  ts.isFunctionDeclaration(d) ||
  (ts.isVariableDeclaration(d) &&
    !!d.initializer &&
    (ts.isArrowFunction(d.initializer) ||
      ts.isFunctionExpression(d.initializer)));

export const isExported = (statement: ts.Node) =>
  ts.canHaveModifiers(statement) &&
  !!ts
    .getModifiers(statement)
    ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const commentText = (
  comment: string | ts.NodeArray<ts.JSDocComment> | undefined,
) =>
  typeof comment === "string"
    ? comment
    : (comment?.map((c) => c.text).join("") ?? "");

const tagText = (text: string) => text.replace(/\s+/g, " ").trim();

/** The text of the JSDoc a declaration carries (the last, as the compiler reads it), or null. */
export function docTextOf(node: ts.Node): string | null {
  const doc = ts
    .getJSDocCommentsAndTags(holderOf(node))
    .filter(ts.isJSDoc)
    .at(-1);
  if (!doc || doc.comment === undefined) return null;
  return commentText(doc.comment).trim() || null;
}

/** A declaration's JSDoc tags: `@control`, `@principle P4`. */
export const tagsOf = (node: ts.Node): Tag[] =>
  ts.getJSDocTags(holderOf(node)).map((tag) => ({
    name: tag.tagName.text,
    text: tagText(commentText(tag.comment)),
  }));

/** Tags written as text, one per `@` at the start of a line, as JSDoc reads them. */
export const tagsIn = (text: string): Tag[] =>
  text
    .split(/^(?=\s*@\w)/m)
    .map((chunk) => /^\s*@(\w+)\s*([\s\S]*)$/.exec(chunk))
    .filter((m) => m !== null)
    .map((m) => ({ name: m[1]!, text: tagText(m[2]!) }));
