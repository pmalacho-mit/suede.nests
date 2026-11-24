// A TypeDoc plugin: a function's tests become the "Claims" on its own page.
//
//   "plugin": ["typedoc-plugin-markdown", "./<path-to-library>/describe/typedoc.mts"]
//
// A namespace of tests is a type-level `declare namespace` merged with the
// value it is named after. TypeDoc leaves an unexported one out of the docs and
// gives an exported one a page of its own, a page per test; either way the
// tests are not read as what they are. This plugin takes them out of the
// output, reads them through the docs model (model.mts, project.mts), and puts
// each function's claims on the function's page: what it answers, what it
// refuses, each in its author's words with its evidence in shorthand, a table's
// rows as a table, and who calls it. A `{@link fn.Alias}` in the function's
// prose then links to that claim, on the same page.
import path from "node:path";
import {
  Comment,
  CommentTag,
  Converter,
  DeclarationReflection,
  ReflectionKind,
  ReflectionSymbolId,
} from "typedoc";

import { claimSections } from "./cards.mts";
import { projectDocs } from "./project.mts";
import { qualifiedName } from "./model.mts";
import { holdsTests } from "../vite-plugin/discovery.mts";

import type {
  Application,
  CommentDisplayPart,
  Context,
  InlineTagDisplayPart,
  ProjectReflection,
  Reflection,
} from "typedoc";
import type { FileDocs, SubjectDoc } from "./model.mts";
import type { ProjectDocs } from "./project.mts";

const LINK_TAGS = new Set(["@link", "@linkcode", "@linkplain"]);

/** Where an anchor to a claim goes: `claim-<alias>`. */
export const claimAnchor = (alias: string) => `claim-${alias}`;

// before the removal and the claims, so both can ask where a reflection was written
const fileOf = (context: Context, reflection: Reflection) =>
  context
    .getSymbolFromReflection(reflection)
    ?.declarations?.[0]?.getSourceFile().fileName ?? null;

// `Tests.Counter.Increment`, as a namespace path and an alias, for a reflection inside namespaces
const reflectionName = (reflection: Reflection) => {
  const names = [reflection.name];
  for (
    let p = reflection.parent;
    p?.kindOf(ReflectionKind.Namespace);
    p = p.parent
  )
    names.unshift(p.name);
  return names.join(".");
};

const isTopLevel = (r: Reflection) =>
  !r.parent || r.parent.kindOf(ReflectionKind.Project | ReflectionKind.Module);

type Read = {
  model: ProjectDocs;
  /** By absolute file: its docs. */
  files: Map<string, FileDocs>;
};

// the files the documented reflections were written in that hold tests, each looked at once;
// the model is built with the library's own TypeScript, which may not be the one TypeDoc runs
function read(context: Context, app: Application): Read | null {
  const checked = new Set<string>();
  const sources: string[] = [];
  for (const r of Object.values(context.project.reflections)) {
    const file = fileOf(context, r);
    if (!file || checked.has(file)) continue;
    checked.add(file);
    const program = context.programs.find((p) => p.getSourceFile(file));
    const source = program?.getSourceFile(file);
    if (
      source &&
      !program!.isSourceFileFromExternalLibrary(source) &&
      holdsTests(source.text)
    )
      sources.push(file);
  }
  if (!sources.length) return null;
  const tsconfig = path.resolve(String(app.options.getValue("tsconfig")));
  const root = path.dirname(tsconfig);
  const model = projectDocs({ root, tsconfig, files: sources });
  return {
    model,
    files: new Map(model.files.map((f) => [path.resolve(root, f.file), f])),
  };
}

// a test is a type alias the docs model read as one; a namespace left empty by its going goes too
function removeTests(context: Context, { files }: Read) {
  const project = context.project;
  const tests = new Map(
    [...files].map(([file, docs]) => [
      file,
      new Set(docs.claims.map(qualifiedName)),
    ]),
  );
  for (const r of project.getReflectionsByKind(ReflectionKind.TypeAlias)) {
    const file = fileOf(context, r);
    if (file && tests.get(file)?.has(reflectionName(r)))
      project.removeReflection(r);
  }
  for (let removed = true; removed; ) {
    removed = false;
    for (const ns of project.getReflectionsByKind(ReflectionKind.Namespace)) {
      const file = fileOf(context, ns);
      if (
        !file ||
        !tests.has(file) ||
        (ns as DeclarationReflection).children?.length
      )
        continue;
      const name = reflectionName(ns);
      if ([...tests.get(file)!].some((t) => t.startsWith(`${name}.`))) {
        project.removeReflection(ns);
        removed = true;
      }
    }
  }
}

/** A subject's claims, as the Markdown under its "Claims" heading. */
export function claimsMarkdown(
  subject: SubjectDoc,
  file: FileDocs,
  model: Pick<ProjectDocs, "references" | "results">,
): string {
  // the card's heading, signature and description are what TypeDoc shows already
  return claimSections(subject, file, model, { anchor: claimAnchor })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Claimed = { subject: DeclarationReflection; alias: string };

function addClaims(
  context: Context,
  { model, files }: Read,
): Map<string, Claimed[]> {
  const project = context.project;
  const byName = new Map<string, Claimed[]>();
  const kinds =
    ReflectionKind.Function | ReflectionKind.Class | ReflectionKind.Variable;
  for (const r of project.getReflectionsByKind(kinds)) {
    if (!(r instanceof DeclarationReflection) || !isTopLevel(r)) continue;
    const file = fileOf(context, r);
    const docs = file ? files.get(file) : undefined;
    const subject = docs?.subjects.find((s) => s.name === r.name);
    if (!docs || !subject) continue;
    const text = claimsMarkdown(subject, docs, model);
    if (!text) continue;
    // a function's comment is on its signature
    const holder = r.signatures?.[0] ?? r;
    holder.comment ??= new Comment();
    holder.comment.blockTags.push(
      new CommentTag("@claims", [{ kind: "text", text }]),
    );
    for (const c of docs.claims.filter((c) =>
      subject.claims.includes(c.name),
    )) {
      const name = qualifiedName(c);
      const list = byName.get(name) ?? [];
      if (!list.some((x) => x.subject === r))
        list.push({ subject: r, alias: c.alias });
      byName.set(name, list);
    }
  }
  return byName;
}

const onPageOf = (reflection: Reflection, subject: Reflection) => {
  for (let r: Reflection | undefined = reflection; r; r = r.parent)
    if (r === subject) return true;
  return false;
};

// `{@link parseMemory.Spellings | read}` → `read`, on the claim; TypeDoc leaves a link with a target alone
function linkToClaims(
  project: ProjectReflection,
  claims: Map<string, Claimed[]>,
) {
  const relink = (owner: Reflection, parts: CommentDisplayPart[]) => {
    for (const part of parts) {
      if (part.kind !== "inline-tag" || !LINK_TAGS.has(part.tag)) continue;
      const link = part as InlineTagDisplayPart;
      if (
        typeof link.target === "string" ||
        (link.target && !(link.target instanceof ReflectionSymbolId))
      )
        continue;
      const [written, caption] = link.text.split("|").map((s) => s.trim());
      const name =
        link.target instanceof ReflectionSymbolId
          ? link.target.qualifiedName
          : written!;
      const found = claims.get(name);
      if (!found?.length) continue;
      const here = found.find((c) => onPageOf(owner, c.subject)) ?? found[0]!;
      link.target = onPageOf(owner, here.subject)
        ? `#${claimAnchor(here.alias)}`
        : here.subject;
      link.text = link.tsLinkText || caption || name;
    }
  };
  for (const r of Object.values(project.reflections)) {
    if (!r.comment) continue;
    relink(r, r.comment.summary);
    for (const tag of r.comment.blockTags) relink(r, tag.content);
  }
}

/** TypeDoc's entry point for a plugin. */
export function load(app: Application) {
  let found: Read | null = null;
  // early, so groups and categories are made without the tests
  app.converter.on(
    Converter.EVENT_RESOLVE_BEGIN,
    (context: Context) => {
      found = read(context, app);
      if (found) removeTests(context, found);
    },
    1000,
  );
  // after comments have moved onto signatures, and before TypeDoc resolves links (at -300)
  app.converter.on(
    Converter.EVENT_RESOLVE_END,
    (context: Context) => {
      if (!found) return;
      linkToClaims(context.project, addClaims(context, found));
      found = null;
    },
    100,
  );
}
