// The docs model: what a file's tests say, read off the printer's IR. Built
// for a whole project by `cli.mts docs model` (project.mts), which adds what
// only the whole program knows: who calls what.
import ts from "@typescript/typescript6";

import { printExpr, printTest } from "../vite-plugin/emit/print.mts";
import { children, DSL_KINDS, exprsOfTest } from "../vite-plugin/emit/ir.mts";
import {
  docTextOf,
  holderOf,
  isExported,
  isFunctionLike,
  tagsOf,
  topLevelDeclarations,
} from "../vite-plugin/emit/declarations.mts";
import { shorthand } from "./shorthand.mts";
import { lookupFor } from "./lookup.mts";

import type { EmitInput } from "../vite-plugin/emit/index.mts";
import type { Binding, Expr, Tag, TestCase } from "../vite-plugin/emit/ir.mts";
import type { Lookup } from "./shorthand.mts";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";
import type * as harness from "../_internal/harness.mts";

export const MODEL_VERSION = 1;

/** What every join between a claim and its run, its diff or its links goes by. */
export const claimId = (file: string, name: string) => `${file} > ${name}`;

/** What every join between a subject and its references goes by. */
export const subjectId = (file: string, name: string) => `${file}#${name}`;

/** One test, as documentation. Lines are 1-based. */
export type ClaimDoc = {
  /** `claimId(file, name)`. */
  id: string;
  name: string;
  path: string[];
  alias: string;
  row: number | null;
  line: number;
  /** The alias's `/** … *\/`: what the test, or every row of the table, shows. */
  doc: string | null;
  /** A row's own `/** … *\/`, written just before it. */
  rowDoc: string | null;
  tags: Tag[];
  mode: TestCase["mode"];
  /** A test of what is refused (a throw, a null, a false), or of what is answered. */
  kind: "refuses" | "answers";
  /** The evidence: the test Vitest runs, without the words above it. */
  code: string;
  /** The evidence in shorthand: what the printed test sets up, does and checks, a line of code each. */
  shorthand: string[];
  /** A table row's call, cell by cell, for a docs table. */
  cells: {
    args: [label: string | null, value: string][];
    condition: string;
    expected: string | null;
  } | null;
  uses: {
    /** Harness functions: values imported `import type` and re-imported to run. */
    harness: { from: string; name: string }[];
    mocks: { path: string; with: string | null }[];
    setup: string[];
    /** The DSL's values beyond literals this test needed: `Caught`, `Spy`, `TempDir`, … */
    dsl: string[];
  };
};

/** A function, class or const that a namespace of tests is named after. */
export type SubjectDoc = {
  name: string;
  kind: "function" | "class" | "const";
  line: number;
  exported: boolean;
  signature: string;
  doc: string | null;
  tags: Tag[];
  /** The names of its tests, in order. */
  claims: string[];
};

export type FileDocs = {
  file: string;
  subjects: SubjectDoc[];
  claims: ClaimDoc[];
};

/** The words that say what a claim shows: its row's own, or else its alias's. */
export const claimWords = (c: ClaimDoc) => c.rowDoc ?? c.doc;

/** `parseMemory.Spellings`: how prose names a claim, and how `{@link}` finds it. */
export const qualifiedName = (c: Pick<ClaimDoc, "path" | "alias">) =>
  [...c.path, c.alias].join(".");

/** Claims grouped as they were written: a table's rows together, every other claim alone. In order. */
export function groupClaims(claims: ClaimDoc[]): ClaimDoc[][] {
  const groups = new Map<string, ClaimDoc[]>();
  for (const c of claims) {
    const key = c.row === null ? c.id : qualifiedName(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()];
}

function dslUsed(t: TestCase): string[] {
  const found = new Set<string>(
    t.setup.map((s) => (s.kind === "fakeTimers" ? "FakeTimers" : "StubEnv")),
  );
  const walk = (e: Expr): void => {
    const kind = DSL_KINDS[e.kind];
    if (kind) found.add(kind.dsl);
    children(e).forEach(walk);
  };
  exprsOfTest(t).forEach(walk);
  return [...found].sort();
}

// an alias is what it stands for: `type Refused = Caught<…>` is a caught error
const valueOf = (e: Expr, bindings: Binding[]): Expr => {
  switch (e.kind) {
    case "name": {
      const bound = bindings.find((b) => b.name === e.name && !b.params);
      return bound ? valueOf(bound.value, bindings) : e;
    }
    case "index":
      return valueOf(e.object, bindings);
    case "paren":
      return valueOf(e.inner, bindings);
    default:
      return e;
  }
};

const REFUSING_VALUES = ["null", "false", "undefined"];

// a refusal is what a guard says: it throws, or answers null or false; a claim
// that also shows what is answered is about the answer, so every assertion has to refuse
const isRefusal = (t: TestCase) => {
  const asserted = t.body.filter((s) => s.kind === "assert");
  return (
    asserted.length > 0 &&
    asserted.every(
      (s) =>
        s.condition === "throws" ||
        s.condition === "falsy" ||
        valueOf(s.actual, t.bindings).kind === "caught" ||
        (s.condition === "=" &&
          s.expected?.kind === "literal" &&
          REFUSING_VALUES.includes(s.expected.source)),
    )
  );
};

declare namespace isRefusal {
  /** a throw, a null and a false are refusals; a value is an answer */
  export type Kinds = Table<
    typeof harness.claimKind,
    [
      [
        args: [
          source: 'const f = (x: string) => x;\ndeclare namespace f { export type T = Throws<Invoke<typeof f, [x: ""]>>; }',
          alias: "T",
        ],
        expected: "refuses",
      ],
      [
        args: [
          source: 'const f = (x: string) => null;\ndeclare namespace f { export type T = Expect<Invoke<typeof f, [x: ""]>, "=", null>; }',
          alias: "T",
        ],
        expected: "refuses",
      ],
      [
        args: [
          source: 'const f = (x: string) => x;\ndeclare namespace f { export type T = Expect<Invoke<typeof f, [x: "a"]>, "=", "a">; }',
          alias: "T",
        ],
        expected: "answers",
      ],
      /** a caught error is a refusal, however many aliases away */
      [
        args: [
          source: 'const f = (x: string) => x;\ndeclare namespace f { type E = Caught<Invoke<typeof f, [x: ""]>>; export type T = Expect<E["message"], "=", "no">; }',
          alias: "T",
        ],
        expected: "refuses",
      ],
    ]
  >;
}

const cellsOf = (t: TestCase): ClaimDoc["cells"] => {
  const [first] = t.body;
  if (
    t.row === null ||
    !first ||
    first.kind !== "assert" ||
    first.actual.kind !== "call"
  )
    return null;
  const { args, labels } = first.actual;
  return {
    args: args.map((a, i) => [labels?.[i] ?? null, printExpr(a)]),
    condition: first.condition,
    expected: first.expected ? printExpr(first.expected) : null,
  };
};

// the harness functions a test calls, as the IR says where each was imported from
function harnessOf(t: TestCase): ClaimDoc["uses"]["harness"] {
  const found = new Map<string, { from: string; name: string }>();
  const walk = (e: Expr): void => {
    if (e.kind === "name" && e.imported)
      found.set(`${e.imported.from}\0${e.imported.name}`, e.imported);
    children(e).forEach(walk);
  };
  exprsOfTest(t).forEach(walk);
  return [...found.values()];
}

/** One test, as documentation. */
export function claimOf(t: TestCase, file: string, lookup: Lookup): ClaimDoc {
  return {
    id: claimId(file, t.name),
    name: t.name,
    path: t.path,
    alias: t.alias,
    row: t.row,
    line: t.line + 1,
    doc: t.doc?.text ?? null,
    rowDoc: t.rowDoc?.text ?? null,
    tags: t.tags,
    mode: t.mode,
    kind: isRefusal(t) ? "refuses" : "answers",
    code: printTest({ ...t, doc: null, rowDoc: null }).code,
    shorthand: shorthand(t, lookup),
    cells: cellsOf(t),
    uses: {
      harness: harnessOf(t),
      mocks: t.mocks.map((m) => ({
        path: m.path,
        with: m.replacement?.name ?? null,
      })),
      setup: t.setup.map((s) =>
        s.kind === "fakeTimers"
          ? "fake timers"
          : s.value
            ? `${s.name}=${printExpr(s.value)}`
            : `${s.name} unset`,
      ),
      dsl: dslUsed(t),
    },
  };
}

// `declare namespace Tests.Counter` covers `Counter`: the first segment that names a value
export const subjectName = (path: string[], values: Map<string, unknown>) =>
  path.find((segment) => values.has(segment)) ?? null;

declare namespace subjectName {
  export type Finds = Table<
    typeof subjectName,
    [
      [
        args: [
          path: ["add"],
          values: Invoke<typeof harness.valueNames, [names: ["add"]]>,
        ],
        expected: "add",
      ],
      [
        args: [
          path: ["Tests", "Counter"],
          values: Invoke<typeof harness.valueNames, [names: ["Counter"]]>,
        ],
        expected: "Counter",
      ],
      [
        args: [
          path: ["Tests"],
          values: Invoke<typeof harness.valueNames, [names: ["add"]]>,
        ],
        expected: null,
      ],
    ]
  >;
}

/** A declaration's 1-based line, counted from its statement (which holds its JSDoc and `export`). */
export const lineOf = (declaration: ts.Declaration) =>
  declaration
    .getSourceFile()
    .getLineAndCharacterOfPosition(holderOf(declaration).getStart()).line + 1;

function subjectOf(
  checker: ts.TypeChecker,
  name: string,
  declaration: ts.Declaration,
  claims: string[],
): SubjectDoc {
  const nameNode = ts.getNameOfDeclaration(declaration)!;
  const symbol = checker.getSymbolAtLocation(nameNode);
  const type = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, nameNode)
    : undefined;
  const signature = type?.getCallSignatures()[0];
  const flags = ts.TypeFormatFlags.NoTruncation;
  return {
    name,
    kind: ts.isClassDeclaration(declaration)
      ? "class"
      : isFunctionLike(declaration)
        ? "function"
        : "const",
    line: lineOf(declaration),
    exported: isExported(holderOf(declaration)),
    signature: signature
      ? checker.signatureToString(signature, undefined, flags)
      : type
        ? checker.typeToString(type, undefined, flags)
        : "",
    doc: docTextOf(declaration),
    tags: tagsOf(declaration),
    claims,
  };
}

/** A file's tests, as documentation: `tests` is what the printer made of it. */
export function fileDocs(
  { program, source }: EmitInput,
  tests: TestCase[],
  file: string,
): FileDocs {
  const checker = program.getTypeChecker();
  const lookup = lookupFor(checker, source);
  const values = topLevelDeclarations(source);
  const claims = tests.map((t) => claimOf(t, file, lookup));
  const bySubject = new Map<string, string[]>();
  for (const c of claims) {
    const name = subjectName(c.path, values);
    if (name) bySubject.set(name, [...(bySubject.get(name) ?? []), c.name]);
  }
  const subjects = [...bySubject].map(([name, names]) =>
    subjectOf(checker, name, values.get(name)!.declaration, names),
  );
  return { file, subjects, claims };
}

declare namespace fileDocs {
  type Suite = `
    /** Memory in MiB. */
    export const parseMemory = (value: string): number | null => (value === "8g" ? 8192 : null);
    declare namespace parseMemory {
      /** suffixes are read */
      export type Spellings = Table<typeof parseMemory, [
        [args: [value: "8g"], expected: 8192],
        /**
         * anything else is not memory
         * @control
         */
        [args: [value: "lots"], expected: null],
      ]>;
    }
  `;

  /** a subject is the value its namespace is named after, with its own words and the names of its tests */
  export type Subject = Expect<
    Invoke<typeof harness.docsOf, [source: Suite]>,
    "matches",
    {
      subjects: [
        {
          name: "parseMemory";
          kind: "function";
          exported: true;
          signature: "(value: string): number | null";
          doc: "Memory in MiB.";
          claims: ["parseMemory > Spellings[0]", "parseMemory > Spellings[1]"];
        },
      ];
    }
  >;

  /** a row with words of its own keeps them beside its table's, and its tags; its cells are named */
  export type Row = Expect<
    Invoke<typeof harness.docsOf, [source: Suite]>,
    "matches",
    {
      claims: [
        {
          id: "snippet.ts > parseMemory > Spellings[0]";
          doc: "suffixes are read";
          rowDoc: null;
          kind: "answers";
          tags: [];
        },
        {
          doc: "suffixes are read";
          rowDoc: "anything else is not memory";
          kind: "refuses";
          tags: [{ name: "control"; text: "" }];
          shorthand: ['parseMemory("lots") → null'];
          cells: {
            args: [["value", '"lots"']];
            condition: "=";
            expected: "null";
          };
        },
      ];
    }
  >;
}
