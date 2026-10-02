# [Suede](https://github.com/pmalacho-mit/suede) Core (`main`)

Vendored at `.suede/core` on your dependency's **`main`** branch. These are the
maintainer's tools and the scripts CI runs — none of them ship to consumers.
(The consumer-facing half is vendored from `dependency/release/core` onto the
`release` branch, at the same path, and on `main` you have a copy of it at
`release/.suede/core`.)

All of it is bash. Every script runs from the repository root whatever
directory you call it from, and applies one rule:

> A **release dependency** is a root entry named `<repo><sep><name>` — a
> symlink, by convention, which the installer creates — that resolves to a
> folder holding a `.gitrepo` outside `release/`. `<repo>` is this repository's
> name and `<sep>` is `.` or `__`. Nothing else declares one.

This folder is a [git-subrepo](https://github.com/ingydotnet/git-subrepo) of the
suede library, so you get fixes by pulling rather than by editing:

```bash
bash .suede/core/sync.sh
```

## What CI runs

You do not invoke these by hand; the workflows in `.github/workflows` call them,
and they live here rather than in YAML so they can be tested without a runner.

### [push-release.sh](./push-release.sh)

The whole publish flow, run by `subrepo-push-release` when a change under
`release/` lands on `main`: regenerate the dependency records, **guard**, then
sync `release/` out to the `release` branch.

The guard is the part worth knowing about. A release dependency ships as a
*pointer*, so before that pointer goes out it checks two things:

- [`diff.sh`](#diffsh) — no release dependency has drifted from its pinned
  commit, so the pointer is honest;
- `deps.sh --check --in release` — every dependency this repository declares
  is actually in place, and so is everything *they* declare, all the way down.

If either fires, the reason goes into the job summary and **the `release`
branch is not touched**, so consumers stay on the last honest version.

```bash
DRY_RUN=1 bash .suede/core/push-release.sh   # stop after the guard
```

`RELEASE_DIR` (default `release`) overrides which folder is published, and
`SUEDE_RELEASE_CORE` where the consumer-facing `diff` and `deps.sh` are read
from (default `release/.suede/core`; if that copy predates `deps.sh`, the guard
tells you to run `sync.sh`).

### [rebuild-pr-branch.sh](./rebuild-pr-branch.sh)

Turns a consumer's `upstream` into something you can review. Given the
`downstream/**` branch their push created, it recovers the release commit they
branched from, replays their change onto the current release (conflicts become
markers), and transplants the result under `release/` on top of `main`.

Run by `suede-downstream-to-main`, which lives on the `release` branch but
checks out `main` — which is why this script is here and not in `release/core`.

### [open-pull-request.sh](./open-pull-request.sh)

Composes the PR description for that rebuilt branch and opens it. "Open a PR" is
the one step that differs between forges, so it sits behind a backend switch:
`gh` on GitHub, the Gitea API (via `jq`) in the offline test harness, and
`print` to see the description without opening anything.

```bash
SUEDE_PR_BACKEND=print bash .suede/core/open-pull-request.sh   # dry run
```

## What you run

### [extract.sh](./extract.sh)

Writes `release/.suede/.dependencies/` from what the tree declares: one
`<entry>.gitrepo` per release dependency, holding the HTTPS remote, the branch
and the commit. A consumer's `deps.sh` reads these and recreates each entry
beside the installed copy of your dependency — so the record's *name* is the
sibling path your `release/` code imports (`../<entry>/...`).

```bash
bash .suede/core/extract.sh
```

Anything else in that folder is removed: a record whose entry is gone, and the
`package.json`, `requirements.txt` and `separator` files older versions
generated. The publish flow runs this; run it yourself to see what would ship.

### [list.sh](./list.sh)

Every dependency in the repository and what kind it is — the rule above, read
off the tree:

```
KIND         ENTRY                      PATH                       PIN
release      my-app.widget              widget                     86abeeb
development  -                          fixtures/harness           4f10c2a
vendored     -                          release/mixin              9bb0e41
```

### [diff.sh](./diff.sh)

Every release dependency that no longer matches the commit its `.gitrepo` names.
Non-empty output means your pointer is dishonest — you would ship a pointer to
code that is not what you built against. The publish guard runs the same check,
so a clean `diff.sh` here means a publish that will not be refused for that
reason.

```bash
bash .suede/core/diff.sh
```

Each dependency is compared with the `diff` that ships in `release/.suede/core`,
so your view and a consumer's cannot disagree. Vendored dependencies are exempt
(one exists precisely *because* it diverges, and it ships as source) and so are
development dependencies (they ship nothing).

If it reports divergence you have three honest options: revert the changes,
[upstream](../../release/core/README.md#upstream) them, or **vendor** the
dependency so the source itself ships. Vendoring is two git commands and a
review of your imports:

```bash
git mv widget release/widget          # the bytes now ship
git rm my-app.widget                  # no longer a pointer, so no declaration
grep -rn 'my-app.widget' release/     # repoint these to ./widget
```

Vendored code ships whole, so whatever `widget` needs beside it has to move
inside `release/` too — `deps.sh --in release/widget` will tell you what.

### [sync.sh](./sync.sh)

Updates every piece of suede machinery this repository vendors, in one command,
from `main`:

```bash
bash .suede/core/sync.sh
```

It finds them rather than being told — every subrepo whose remote is the suede
library. In a fully initialized dependency that is four:

| Path | What it is |
| --- | --- |
| `.suede/core` | this folder, the maintainer's tools |
| `release/.suede/core` | the tools that ship to consumers |
| `.github/workflows` | main's workflows |
| `release/.github/workflows` | the release branch's workflows |

`./release` is deliberately not one of them: it tracks *your* release branch and
is published by [push-release.sh](#push-releasesh), not pulled.

**Why this is a script and not four `git subrepo pull`s.** Two of the four
record a `parent` that is not a commit in this repository's history, so a plain
pull refuses:

- The **workflow** subrepos were cloned into the *template* your repository was
  created from. A repository made from a template starts a fresh history, so
  their parent names a commit that does not exist here at all. (They live in the
  template rather than being cloned at init because an Action is restricted in
  what it may do to `.github/workflows`.)
- A **`.suede/core` vendored onto the `release` branch** before the layout
  changed records a parent that does exist, but is a release-branch commit and
  so not an ancestor of `main`.

Both get repaired the same way — point `parent` at a commit that *is* in this
history, then pull — so `sync.sh` does it and retries instead of making you read
the diagnostic. It also clears the `subrepo/…` branch and `.git/tmp/subrepo/…`
directory that pulling a subrepo nested inside `release/` leaves behind, because
those stop the next `git subrepo push release` — the very next thing publishing
does.

Pass paths to limit it: `bash .suede/core/sync.sh .github/workflows`.

### [lib.sh](./lib.sh)

Not a command. The handful of functions the scripts above share — the
repository's name, the list of release dependencies, the HTTPS spelling of a
remote — so the rule is written once.
