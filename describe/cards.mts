// A file's docs as Markdown: for each function its tests are named after, what
// it is, what it answers and what it refuses (each claim in its author's words,
// with its evidence in shorthand under it), who calls it, and what the tests
// stood in for it.
import { claimWords, groupClaims, subjectId } from "./model.mts";
import { codeBlock, codeSpan } from "./shorthand.mts";

import type { ClaimDoc, FileDocs, SubjectDoc } from "./model.mts";
import type { ProjectDocs, Reference } from "./project.mts";
import type * as harness from "../_internal/harness.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

const MARKS: Record<string, string> = {
  passed: "✓",
  failed: "✗",
  skipped: "–",
  pending: "…",
};

/** How the last run went for a test, as a mark: nothing when there was no run. */
export const markOf = (state: string | undefined) =>
  state ? (MARKS[state] ?? "") : "";

declare namespace markOf {
  export type Marks = Table<
    typeof markOf,
    [
      [args: [state: "passed"], expected: "✓"],
      [args: [state: "failed"], expected: "✗"],
      [args: [state: undefined], expected: ""],
    ]
  >;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const tick = (text: string) => `\`${cell(text)}\``;

// how a claim's name is written: with the anchor a link to it goes to, the first time
type Render = {
  mark: (c: ClaimDoc) => string;
  name: (alias: string) => string;
};

// rows of one table, as a Markdown table whose columns are what the arguments are called
function rowsTable(rows: ClaimDoc[], mark: Render["mark"]): string[] {
  const first = rows[0]!.cells!;
  const labels = first.args.map(([label], i) => label ?? `arg ${i + 1}`);
  const conditions = rows.some((r) => r.cells!.condition !== "=");
  const own = rows.some((r) => r.rowDoc !== null);
  const head = [
    ...labels,
    ...(conditions ? ["condition"] : []),
    "expected",
    ...(own ? ["shows"] : []),
    "",
  ];
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => {
      const c = r.cells!;
      const values = [
        ...labels.map((_, i) => tick(c.args[i]?.[1] ?? "")),
        ...(conditions ? [c.condition] : []),
        c.expected === null ? "" : tick(c.expected),
        ...(own ? [cell(r.rowDoc ?? "")] : []),
        mark(r),
      ];
      return `| ${values.join(" | ")} |`;
    }),
  ];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ");

const claimItem = (c: ClaimDoc, { mark, name }: Render) => {
  const words = claimWords(c);
  const tags = c.tags.length
    ? ` ${c.tags.map((t) => `\`@${t.name}${t.text ? ` ${t.text}` : ""}\``).join(" ")}`
    : "";
  return [
    `- ${name(c.alias)}${words ? `: ${oneLine(words)}` : " _(no words of its own)_"} ${mark(c)}${tags}`.trimEnd(),
    ...evidence(c.shorthand),
  ];
};

// a line of evidence under its claim; several, as the block of code they are
const evidence = (lines: string[]) =>
  lines.length > 1
    ? codeBlock(lines, "  ")
    : lines.map((l) => `  - ${codeSpan(l)}`);

const tableItem = (rows: ClaimDoc[], render: Render) => {
  const words = rows[0]!.doc;
  return [
    "",
    `- ${render.name(rows[0]!.alias)}${words ? `: ${oneLine(words)}` : ""}`,
    "",
    ...rowsTable(rows, render.mark).map((l) => `  ${l}`),
    "",
  ];
};

// a table is its rows; anything else is a claim with its evidence under it
const section = (title: string, claims: ClaimDoc[], render: Render) =>
  claims.length
    ? [
        `**${title}**`,
        "",
        ...groupClaims(claims).flatMap((group) =>
          group[0]!.cells
            ? tableItem(group, render)
            : claimItem(group[0]!, render),
        ),
        "",
      ]
    : [];

const callersOf = (refs: Reference[], limit = 8) => {
  const production = refs.filter((r) => r.role === "production");
  const seen = new Map<string, Reference>();
  for (const r of production)
    seen.set(`${r.file}#${r.caller}`, seen.get(`${r.file}#${r.caller}`) ?? r);
  const listed = [...seen.values()]
    .slice(0, limit)
    .map((r) => `\`${r.caller}\` (${r.file}:${r.line})`);
  const more = seen.size - listed.length;
  return production.length
    ? `**Used by** ${production.length} reference${production.length === 1 ? "" : "s"} in ${new Set(production.map((r) => r.file)).size} file(s): ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}`
    : "**Used by** no other code: an entry point, or reached in a way references do not show (a dynamic `import()`, a table of commands)";
};

const standsIn = (claims: ClaimDoc[]) => {
  const harness = [
    ...new Set(
      claims.flatMap((c) =>
        c.uses.harness.map((h) => `\`${h.name}\` (${h.from})`),
      ),
    ),
  ];
  const mocks = [
    ...new Set(
      claims.flatMap((c) =>
        c.uses.mocks.map(
          (m) => `\`${m.path}\`${m.with ? ` → \`${m.with}\`` : ""}`,
        ),
      ),
    ),
  ];
  const setup = [...new Set(claims.flatMap((c) => c.uses.setup))];
  const parts = [
    harness.length && `harness ${harness.join(", ")}`,
    mocks.length && `replaced ${mocks.join(", ")}`,
    setup.length && `set up ${setup.map(tick).join(", ")}`,
  ].filter(Boolean);
  return parts.length ? [`**Stands in for it** ${parts.join("; ")}`, ""] : [];
};

export type SectionOptions = {
  /** An `id` for each claim's first appearance, so prose can link to it: `claim-Reads`. */
  anchor?: (alias: string) => string;
};

/** What a subject's tests say of it, without its heading: what it answers and refuses, who calls it, what stood in. */
export function claimSections(
  s: SubjectDoc,
  file: FileDocs,
  project: Pick<ProjectDocs, "references" | "results"> | null,
  { anchor }: SectionOptions = {},
): string[] {
  const claims = file.claims.filter((c) => s.claims.includes(c.name));
  const anchored = new Set<string>();
  const render: Render = {
    mark: (c) => markOf(project?.results[c.id]),
    name: (alias) => {
      if (!anchor || anchored.has(alias)) return `**${alias}**`;
      anchored.add(alias);
      return `<a id="${anchor(alias)}"></a>**${alias}**`;
    },
  };
  return [
    ...section(
      "What it answers",
      claims.filter((c) => c.kind === "answers"),
      render,
    ),
    ...section(
      "What it refuses",
      claims.filter((c) => c.kind === "refuses"),
      render,
    ),
    ...(project
      ? [callersOf(project.references[subjectId(file.file, s.name)] ?? []), ""]
      : []),
    ...standsIn(claims),
  ];
}

/** One subject's card: its heading, signature and own words, then its claims. */
export function subjectCard(
  s: SubjectDoc,
  file: FileDocs,
  project: Pick<ProjectDocs, "references" | "results"> | null,
): string[] {
  return [
    `## \`${s.name}\``,
    "",
    "```ts",
    `${s.kind === "class" ? "class " : ""}${s.name}${s.kind === "function" ? s.signature : `: ${s.signature}`}`,
    "```",
    "",
    ...(s.doc ? [s.doc, ""] : []),
    ...claimSections(s, file, project),
  ];
}

/** A file's cards, as one Markdown page. */
export const fileCards = (
  file: FileDocs,
  project: Pick<ProjectDocs, "references" | "results"> | null = null,
) =>
  [
    `# ${file.file}`,
    "",
    ...file.subjects.flatMap((s) => subjectCard(s, file, project)),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "\n");

declare namespace fileCards {
  type Suite = `
    /** Memory in MiB. */
    export const parseMemory = (value: string): number | null => (value === "8g" ? 8192 : null);
    declare namespace parseMemory {
      /** suffixes are read */
      export type Spellings = Table<typeof parseMemory, [
        [args: [value: "8g"], expected: 8192],
        /** anything else is not memory */
        [args: [value: "lots"], expected: null],
      ]>;
    }
  `;

  /** a table's rows are split into what it answers and what it refuses, columns named as the arguments are */
  export type Card = Expect<
    Invoke<
      typeof fileCards,
      [file: Invoke<typeof harness.docsOf, [source: Suite]>]
    >,
    "=",
    '# snippet.ts\n\n## `parseMemory`\n\n```ts\nparseMemory(value: string): number | null\n```\n\nMemory in MiB.\n\n**What it answers**\n\n- **Spellings**: suffixes are read\n\n  | value | expected |  |\n  | --- | --- | --- |\n  | `"8g"` | `8192` |  |\n\n**What it refuses**\n\n- **Spellings**: suffixes are read\n\n  | value | expected | shows |  |\n  | --- | --- | --- | --- |\n  | `"lots"` | `null` | anything else is not memory |  |\n'
  >;
}
