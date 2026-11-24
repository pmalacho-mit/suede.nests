// What a change does, read off the tests rather than the code: the claims it
// adds, the ones it removes, the ones whose evidence changed, and the functions
// it adds with nothing said of them.
//
// A removed claim, a changed one, and one now skipped are what a person should
// approve: each is a guarantee the code no longer makes, or makes differently.
// They are `needsReview`, and `cli.mts docs diff --check` fails on any.
import { claimWords, subjectId } from "./model.mts";
import { codeBlock, codeSpan } from "./shorthand.mts";

import type { ClaimDoc, FileDocs } from "./model.mts";
import type * as harness from "../_internal/harness.mts";
import type { Expect, Invoke } from "../dsl.import.meta.vitest.ts";

type Keyed = { file: string; claim: ClaimDoc };

type Pair = { file: string; before: ClaimDoc; after: ClaimDoc };

export type BehaviorDiff = {
  added: Keyed[];
  removed: Keyed[];
  /** Same test, different evidence: what it runs, and so what it checks or expects, changed. */
  changed: Pair[];
  /** Same evidence, different words: its own, or how its evidence is said. */
  reworded: Pair[];
  /** Was run, now is not. */
  skipped: Keyed[];
  /** Functions with tests now that had none before. */
  newSubjects: { file: string; name: string }[];
  /** What a person should approve: removed, changed or skipped claims. */
  needsReview: number;
};

const keyed = (files: FileDocs[]) =>
  new Map(
    files.flatMap((f) =>
      f.claims.map((claim) => [claim.id, { file: f.file, claim }] as const),
    ),
  );

const words = (c: ClaimDoc) => JSON.stringify([claimWords(c), c.shorthand]);

const runs = (c: ClaimDoc) => c.mode === "test" || c.mode === "test.only";

/** The claims that differ between two readings of a project. */
export function behaviorDiff(
  before: FileDocs[],
  after: FileDocs[],
): BehaviorDiff {
  const a = keyed(before);
  const b = keyed(after);
  const out: BehaviorDiff = {
    added: [],
    removed: [],
    changed: [],
    reworded: [],
    skipped: [],
    newSubjects: [],
    needsReview: 0,
  };
  for (const [key, now] of b) {
    const was = a.get(key);
    if (!was) out.added.push(now);
    else if (runs(was.claim) && !runs(now.claim)) out.skipped.push(now);
    else if (was.claim.code !== now.claim.code)
      out.changed.push({ file: now.file, before: was.claim, after: now.claim });
    else if (words(was.claim) !== words(now.claim))
      out.reworded.push({
        file: now.file,
        before: was.claim,
        after: now.claim,
      });
  }
  for (const [key, was] of a) if (!b.has(key)) out.removed.push(was);
  const subjectsBefore = new Set(
    before.flatMap((f) => f.subjects.map((s) => subjectId(f.file, s.name))),
  );
  out.newSubjects = after.flatMap((f) =>
    f.subjects
      .filter((s) => !subjectsBefore.has(subjectId(f.file, s.name)))
      .map((s) => ({ file: f.file, name: s.name })),
  );
  out.needsReview =
    out.removed.length + out.changed.length + out.skipped.length;
  return out;
}

const said = (c: ClaimDoc) =>
  claimWords(c)?.replace(/\s+/g, " ") ?? "_(no words of its own)_";

// the evidence under a claim, after what it is (`was: `): a line as code, several as a block
const evidence = (c: ClaimDoc, lead = "") => {
  const lines = c.shorthand;
  if (!lines.length) return `\n  - ${lead}_(not written yet)_`;
  if (lines.length === 1) return `\n  - ${lead}${codeSpan(lines[0]!)}`;
  return lead
    ? `\n  - ${lead.trimEnd()}\n${codeBlock(lines, "    ").join("\n")}`
    : `\n${codeBlock(lines, "  ").join("\n")}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A behavior diff, as Markdown a reviewer reads before the code. */
export function diffMarkdown(d: BehaviorDiff): string {
  const lines = [
    `**${plural(d.added.length, "claim")} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.skipped.length} skipped, ${d.reworded.length} reworded.**`,
    d.needsReview
      ? `${plural(d.needsReview, "change")} to what the code guarantees: a person should approve these.`
      : "No guarantee was removed or changed.",
    "",
  ];
  const block = (title: string, items: string[]) =>
    items.length ? [`### ${title}`, "", ...items, ""] : [];
  lines.push(
    ...block(
      "Removed",
      d.removed.map(
        ({ file, claim }) =>
          `- \`${claim.name}\` (${file}): ${said(claim)}${evidence(claim, "was: ")}`,
      ),
    ),
    ...block(
      "Changed",
      d.changed.map(
        ({ file, before, after }) =>
          `- \`${after.name}\` (${file}): ${said(after)}${evidence(before, "was: ")}${evidence(after, "now: ")}`,
      ),
    ),
    ...block(
      "Skipped",
      d.skipped.map(
        ({ file, claim }) => `- \`${claim.name}\` (${file}): ${said(claim)}`,
      ),
    ),
    ...block(
      "Added",
      d.added.map(
        ({ file, claim }) =>
          `- \`${claim.name}\` (${file}): ${said(claim)}${evidence(claim)}`,
      ),
    ),
    ...block(
      "Reworded",
      d.reworded.map(({ before, after }) =>
        said(before) !== said(after)
          ? `- \`${after.name}\`: "${said(before)}" → "${said(after)}"`
          : `- \`${after.name}\`: ${said(after)}${evidence(before, "was: ")}${evidence(after, "now: ")}`,
      ),
    ),
    ...block(
      "Newly described",
      d.newSubjects.map(({ file, name }) => `- \`${name}\` (${file})`),
    ),
  );
  return lines.join("\n");
}

declare namespace behaviorDiff {
  type Before = `
    const isSlug = (v: string) => /^[a-z]+$/.test(v);
    declare namespace isSlug {
      /** lowercase letters */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /** no capitals */
      export type Upper = Expect<Invoke<typeof isSlug, [v: "Acme"]>, "=", false>;
      /** no dots */
      export type Dot = Expect<Invoke<typeof isSlug, [v: "a.b"]>, "=", false>;
    }
  `;
  type After = `
    const isSlug = (v: string) => /^[a-z.]+$/.test(v);
    declare namespace isSlug {
      /** lowercase letters, said differently */
      export type Lower = Expect<Invoke<typeof isSlug, [v: "acme"]>, "=", true>;
      /** no dots */
      export type Dot = Expect<Invoke<typeof isSlug, [v: "a.b"]>, "=", true>;
      /** no digits */
      export type Digit = Expect<Invoke<typeof isSlug, [v: "a1"]>, "=", false>;
    }
  `;

  /** a claim gone, one whose evidence changed, one reworded and one new; two of them need a person */
  export type Changes = Expect<
    Invoke<typeof harness.diffOf, [before: Before, after: After]>,
    "matches",
    {
      added: [{ claim: { name: "isSlug > Digit" } }];
      removed: [{ claim: { name: "isSlug > Upper" } }];
      changed: [
        {
          after: {
            name: "isSlug > Dot";
            shorthand: ['isSlug("a.b") → true'];
          };
        },
      ];
      reworded: [{ after: { doc: "lowercase letters, said differently" } }];
      needsReview: 2;
    }
  >;
}
