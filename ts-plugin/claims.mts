// What the editor shows of a function's tests, wherever the function is: in its
// hover, beside its declaration and at every call site in any file, and as an
// inlay hint after a call whose literal arguments are a row of one of its tables.
//
// It reads the tests with the printer itself, over the program the language
// service already has, so it says what `cli.mts docs` and the printed tests say.
import ts from "@typescript/typescript6";

import { lowerTests } from "../vite-plugin/emit/index.mts";
import { holderOf } from "../vite-plugin/emit/declarations.mts";
import { holdsTests } from "../vite-plugin/discovery.mts";
import { claimWords, fileDocs, groupClaims } from "../describe/model.mts";
import { declarationOf, resolved } from "../describe/lookup.mts";
import { codeBlock, codeSpan } from "../describe/shorthand.mts";

import type { ClaimDoc, FileDocs, SubjectDoc } from "../describe/model.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";
import type * as harness from "./harness.mts";

// tsserver hands an unchanged file the same SourceFile in every program it builds, so a
// file is read once until it is edited (a change only in what it imports shows on its next edit)
const read = new WeakMap<ts.SourceFile, FileDocs | null>();

// a file with no tests of its own is never lowered: a `.d.ts`, a package, one with no namespace
const mayHoldTests = (program: ts.Program, source: ts.SourceFile) =>
  !source.isDeclarationFile &&
  !program.isSourceFileFromExternalLibrary(source) &&
  holdsTests(source.text);

/** What a file's tests say, or null when it has none. */
export function docsOf(
  program: ts.Program,
  source: ts.SourceFile,
): FileDocs | null {
  if (read.has(source)) return read.get(source)!;
  let docs: FileDocs | null = null;
  if (mayHoldTests(program, source)) {
    const { tests } = lowerTests({ program, source });
    docs = tests.length
      ? fileDocs({ program, source }, tests, source.fileName)
      : null;
  }
  read.set(source, docs);
  return docs;
}

// the innermost node that holds `position`
const nodeAt = (source: ts.SourceFile, position: number): ts.Node | null => {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (position >= node.getStart(source) && position < node.getEnd()) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(source, visit);
  return found;
};

export type Described = { docs: FileDocs; subject: SubjectDoc };

/** The function `name` refers to, with its tests, when it has any: through imports, to its own file. */
export function subjectOf(
  program: ts.Program,
  name: ts.Node,
): Described | null {
  if (!ts.isIdentifier(name)) return null;
  const symbol = resolved(
    program.getTypeChecker(),
    program.getTypeChecker().getSymbolAtLocation(name),
  );
  const declaration = declarationOf(symbol);
  if (!symbol || !declaration) return null;
  const source = declaration.getSourceFile();
  // only a top-level value of a file with tests has a namespace of tests named after it
  if (holderOf(declaration).parent !== source || !mayHoldTests(program, source))
    return null;
  const docs = docsOf(program, source);
  const subject = docs?.subjects.find((s) => s.name === symbol.getName());
  return docs && subject ? { docs, subject } : null;
}

const MAX_CLAIMS = 8;
const MAX_ROWS = 3;

const short = (text: string, max = 48) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const tick = (text: string) => `\`${short(text)}\``;

const oneLine = (text: string | null) =>
  text ? text.replace(/\s+/g, " ") : null;

const rowText = (c: ClaimDoc) => {
  const cells = c.cells!;
  const args = cells.args.map(([, value]) => value).join(", ");
  const result =
    cells.expected === null
      ? cells.condition
      : `${cells.condition === "=" ? "→" : cells.condition} ${tick(cells.expected)}`;
  return `${tick(args)} ${result}`;
};

// a table is one line of its rows; any other claim is its words, then its evidence
function groupLine(claims: ClaimDoc[]): string {
  const [first] = claims;
  if (first!.cells) {
    const said = oneLine(first!.doc);
    const rows = claims.slice(0, MAX_ROWS).map(rowText).join("; ");
    const more =
      claims.length > MAX_ROWS ? `; and ${claims.length - MAX_ROWS} more` : "";
    return `- **${first!.alias}**${said ? `: ${said}` : ""}: ${rows}${more}`;
  }
  const said = oneLine(claimWords(first!));
  const lines = first!.shorthand;
  const head = `- **${first!.alias}**${said ? `: ${sentence(said)}` : ""}`;
  // one line of evidence follows the words; several are the block of code they are
  if (lines.length > 1) return [head, ...codeBlock(lines, "  ")].join("\n");
  const code = lines.map(codeSpan).join("");
  if (!code) return head;
  return said ? `${head} ${code}` : `${head}: ${code}`;
}

// the claim's words end where they end: a stop is added only when they have none
const sentence = (text: string) =>
  /[.!?…]$/.test(text) ? text : `${text}.`;

/** A subject's claims, as the Markdown its hover ends with. */
export function claimsMarkdown({ docs, subject }: Described): string {
  const claims = docs.claims.filter((c) => subject.claims.includes(c.name));
  const lines: string[] = [];
  let shown = 0;
  let groups = 0;
  for (const [kind, title] of [
    ["answers", "What it answers"],
    ["refuses", "What it refuses"],
  ] as const) {
    const grouped = groupClaims(claims.filter((c) => c.kind === kind));
    groups += grouped.length;
    const room = MAX_CLAIMS - shown;
    if (!grouped.length || room <= 0) continue;
    lines.push(`**${title}**`, ...grouped.slice(0, room).map(groupLine), "");
    shown += Math.min(room, grouped.length);
  }
  if (groups > shown)
    lines.push(
      `_and ${groups - shown} more, in the tests under \`${subject.name}\`_`,
    );
  return lines.join("\n").trim();
}

/** The Markdown to add to the hover at `position`, or null when it is not on a function with tests. */
export function hoverClaims(
  program: ts.Program,
  fileName: string,
  position: number,
): string | null {
  const source = program.getSourceFile(fileName);
  const node = source && nodeAt(source, position);
  const described = node ? subjectOf(program, node) : null;
  return described ? claimsMarkdown(described) : null;
}

// a literal argument as a value, so `'8g'`, `"8g"` and `8_192` compare as the tests print them
const literalValue = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return JSON.stringify(node.text);
  if (ts.isNumericLiteral(node))
    return JSON.stringify(Number(node.text.replace(/_/g, "")));
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return JSON.stringify(-Number(node.operand.text.replace(/_/g, "")));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (node.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  return undefined;
};

// a printed cell as a value: what `printExpr` wrote is JSON for every literal a call site can hold
export const cellValue = (printed: string): string => {
  try {
    return JSON.stringify(JSON.parse(printed.replace(/(\d)_(?=\d)/g, "$1")));
  } catch {
    return printed;
  }
};

declare namespace cellValue {
  /** however a literal was spelled, the value it is */
  export type Values = Table<
    typeof cellValue,
    [
      [args: [printed: '"8g"'], expected: '"8g"'],
      [args: [printed: "8_192"], expected: "8192"],
      [args: [printed: "-1"], expected: "-1"],
      [args: [printed: "null"], expected: "null"],
      /** what is no JSON stays as it was printed, and so matches no call site */
      [args: [printed: "10n"], expected: "10n"],
    ]
  >;
}

export type Hint = { text: string; position: number };

const calledName = (call: ts.CallExpression): ts.Node =>
  ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;

/** After each call in `span` whose literal arguments are a table row of its callee: what the row says it answers. */
export function rowHints(
  program: ts.Program,
  fileName: string,
  span: { start: number; length: number },
): Hint[] {
  const source = program.getSourceFile(fileName);
  if (!source) return [];
  const end = span.start + span.length;
  const hints: Hint[] = [];
  const visit = (node: ts.Node) => {
    if (node.getEnd() < span.start || node.getStart(source) > end) return;
    if (ts.isCallExpression(node) && node.arguments.length) {
      const values = node.arguments.map(literalValue);
      const described = values.every((v) => v !== undefined)
        ? subjectOf(program, calledName(node))
        : null;
      const claims = described && new Set(described.subject.claims);
      const row = described?.docs.claims.find(
        (c) =>
          claims!.has(c.name) &&
          c.cells?.condition === "=" &&
          c.cells.expected !== null &&
          c.cells.args.length === values.length &&
          c.cells.args.every(
            ([, printed], i) => cellValue(printed) === values[i],
          ),
      );
      if (row?.cells?.expected)
        hints.push({
          text: `→ ${short(row.cells.expected, 40)} · ${row.alias}[${row.row}]`,
          position: node.getEnd(),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hints;
}

declare namespace hoverClaims {
  /** at a call in another file, the hover says what the function's tests show it answers and refuses */
  export type AtACallSite = Expect<
    Invoke<
      typeof harness.hoverOn,
      [file: "uses-memory.ts", needle: "parseMemory("]
    >,
    "=",
    '**What it answers**\n- **Spellings**: suffixes are read: `"8g"` → `8192`; `"512m"` → `512`\n\n**What it refuses**\n- **Spellings**: suffixes are read: `"lots"` → `null`\n- **Empty**: nothing is no memory, not zero. `parseMemory("") throws /empty/`'
  >;

  /** and the same where it is declared */
  export type AtTheDeclaration = Expect<
    Invoke<
      typeof harness.hoverOn,
      [file: "memory.ts", needle: "parseMemory ="]
    >,
    "startsWith",
    "**What it answers**"
  >;

  /** a function with no tests adds nothing */
  export type Untested = Expect<
    Invoke<
      typeof harness.hoverOn,
      [file: "uses-memory.ts", needle: "round(1.5"]
    >,
    "=",
    null
  >;
}

declare namespace rowHints {
  /** a call whose literal arguments are a row is told that row's answer; one that is no row, nothing */
  export type Rows = Expect<
    Invoke<typeof harness.hintsIn, [file: "uses-memory.ts"]>,
    "=",
    ["→ 8192 · Spellings[0]", "→ null · Spellings[2]"]
  >;
}
