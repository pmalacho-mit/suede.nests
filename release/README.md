> [!NOTE]
> This is a [suede](https://github.com/pmalacho-mit/suede) dependency.

## Importing the DSL — the path matters

Import the DSL from the file whose name contains `import.meta.vitest`, and use
that path in **every** file you write tests in:

```ts
// vendored beside your code
import type {
  Expect,
  Invoke,
} from "./namespace-testing/dsl.import.meta.vitest.ts";

// or installed from npm
import type { Expect, Invoke } from "namespace-tests/dsl.import.meta.vitest";
```

That filename is load-bearing, not a joke. Vitest decides which files hold tests
by globbing `includeSource` and keeping the ones whose **raw text** contains the
string `import.meta.vitest` — the check really is a substring match on the bytes
it reads from disk, before any plugin runs. Importing the DSL by this path is
what puts that string in your file, and so is what makes your tests findable.

Two consequences worth knowing:

- **Re-exporting the DSL hides your tests.** If you wrap it in a barrel —
  `export type { Expect } from "namespace-tests/dsl.import.meta.vitest"` — then
  the files importing _your_ barrel no longer contain the marker, and they are
  silently never collected. Import the DSL directly in each file that has tests.
- **Always `import type`.** Vitest rewrites every occurrence of
  `import.meta.vitest` in a file it collects, including the one inside your
  import path. A type-only import is erased before that can matter; a value
  import from the same path would break.

## What counts as a test

Only one thing decides whether a file is looked at: it imports the DSL, so it
carries the marker Vitest keys on. Inside such a file, **every**
`declare namespace` is looked at, and a test is an exported alias whose type
came from the DSL — resolved through the import, so a local type of your own
named `Expect` is yours, and `import type { Expect as Assert }` still reads.

So a namespace is not a suite because of what it is called. Name it after what
it covers, and the test says where it was written:

```ts
declare namespace parseDate {
  export type Iso = Expect<Invoke<typeof parseDate, ["2020-01-01"]>, "truthy">;
}
// parseDate > Iso
```

A test's name is its namespace path exactly as written, so
`declare namespace Tests.parser` gives `Tests > parser > …`. Nothing is
stripped: the name you read in the Test Explorer is the path you can find in
the file.

Exporting an alias is what says "this is a test", and an unexported one is a
helper — that is the only convention. If you export something the printer
cannot run, it says so where you wrote it rather than ignoring it:

```ts
declare namespace add {
  export type Oops = Invoke<typeof add, [1, 1]>;
  // `Invoke<typeof add, [1, 1]>` is not a test:
  // write Expect, Throws, Given or Table (or a tuple of them)
}
```

That arrives as a diagnostic in the editor, on that line, before anything runs.

If you want the rest of a file's namespaces left alone, name the one to look
inside:

```ts
namespaceTests({ root: "Tests" }); // only `declare namespace Tests…`
```

That is an optimisation, not a requirement — there is no default root.

## Asserting on records

When a call hands back records and the test is about one field of each, say so
in the expected value rather than reshaping the actual one. `matches` compares
a deep-partial, element by element:

```ts
export type Anywhere = Expect<
  Invoke<typeof discover, [Suite]>,
  "matches",
  [{ name: "parseDate > Iso" }, { name: "Tests > elsewhere > Deep" }]
>;
```

```ts
expect(discover(Suite)).toMatchObject([
  { name: "parseDate > Iso" },
  { name: "Tests > elsewhere > Deep" },
]);
```

Only the keys you list are compared, at any depth, so the other fields of each
record are free to change. The list itself is not partial: the actual must have
exactly as many elements, in that order.

Both halves of that are Vitest's own rule, not this library's — `matches` on
anything but a string prints `toMatchObject`, and that matcher compares arrays
element-wise, same length, in order, with each element matched partially. (Its
counterpart, `expect.arrayContaining`, is the one that allows extra elements.)
The DSL adds only the type: the expected list is checked against the real record
type, so a misspelled key or a wrongly typed value is a compile error, and a
tuple actual is checked position by position.

## How a test is run

Nothing is written to disk. For a module with tests, the plugin appends a
collector:

```ts
if (import.meta.vitest) {
  await import("./counter.Counter_Chainable.namespace.test.ts");
}
```

and serves each of those ids from memory: the part of your module that test
needs, pruned of everything it does not, followed by the test itself. So every
test gets a fresh copy of the module under test — and of that module's
first-party imports, which are forked per test so state cannot leak from one
test to the next.

Packages are shared, since Vitest hands those to Node. If some first-party
module of yours is _meant_ to be singular — a connection pool, a registry —
name it and every test will share one instance:

```ts
namespaceTests({ noIsolateModuleImport: ["src/db/**", "src/registry.ts"] });
```

Those are globs matched against each module's path relative to the project
root, the same shape as Vitest's own `include`. They name _modules_, not the
specifiers that import them, so one entry covers a module however its importers
happen to spell the path — `./registry.ts` from a sibling and
`../../registry.ts` from further down are the same module, and one pattern
catches both.

## Extracting a test

A test can be written out as a file of its own, beside the module it came from:

```
src/counter.ts  >  Counter > Chainable
src/counter.Counter_Chainable.temp.ts
```

That file is the same thing the plugin serves from memory — the part of your
module the test needs, then the test — except it is real, so everything that
works on a test file works on it. Run it (`npx vitest run
src/counter.Counter_Chainable.temp.ts`), put a breakpoint in it and debug it,
edit it to try something out, delete it when you are done.

The plugin adds `**/*.temp.ts` to Vitest's `include`, since no project's own
`include` is written to catch them. Change the glob, or turn it off, with the
`extracted` option — and add `*.temp.ts` to your `.gitignore`: they are scratch.

```ts
namespaceTests({ extracted: "**/*.scratch.ts" }); // or `extracted: false`
```

The editor extension extracts on a click, and puts Run, Debug and Delete at the
top of the file it wrote.

Extracting is usually instant, because a run has already printed every test in
the file: `release/cli.mts` answers from the cache without loading a compiler at all.
It only does the work when nothing has run yet.

```
node release/cli.mts src/counter.ts "Counter > Chainable" [--runtime <spec>] [--root <ns>]
node release/cli.mts src/counter.ts "Counter > Chainable" --served
node release/cli.mts src/counter.ts --collector
node release/cli.mts --help
```

`--runtime` is how the generated test imports the library's runtime helpers. It
has to match what the plugin uses, or the answer is printed afresh rather than
read back — the editor passes it for you.

What you get is the test, not quite what a run serves: a run also gives each
test its own copy of the first-party modules it reaches, by tagging their
specifiers. `--served` prints that form instead, and shows a table for what it
is — one module per row, not one file with several tests in it. It matters when
the modules under test hold state, which is why an extract of several tests says
so in its header.

## Where things are written

One directory, and it is not in your project: **`.derived/`, inside the
library's own folder** — `release/.derived/` when the library is vendored,
`node_modules/…/.derived/` when it is installed.

```
.derived/
├── diagnostics.json   what the printer could not turn into a value
├── results.json       what the reporter saw, so a failure can be explained
└── cache/             only ever an optimisation; delete it freely
    ├── minimal/       tests the printer has already written out
    └── node/          the compiled form of the modules a command loads
```

The name is the point: nothing in it is authored. Every file is derived from
your source, by this library, for this library — so none of it is yours to read
or edit, and deleting any of it costs nothing but the time to write it again.
The two JSON files are how the editor learns what happened; `cache/` is what
makes it fast. Printed tests are keyed by the source they came from *and* by the
version of the printer, so a changed printer never hands back stale work; Node's
cache holds the compiled form of the modules a command loads, which is what
keeps extracting a test at around 20ms rather than 250ms.

It writes a `.gitignore` of `*` beside itself the first time it is used, so it
stays out of git — and out of whatever else reads your tree. There is nothing to
configure.

To start over:

```
node release/cli.mts --clean-extracted [dir]   # extracted tests under dir (default: here)
node release/cli.mts --clean-cache             # printed tests, and Node's compiled modules
node release/cli.mts --clean [dir]             # both
```

An extracted test is recognised by the header the editor writes, not by its
name, so a file of yours that happens to end in `.temp.ts` is left alone — as is
one that has been edited since it was extracted, unless you add `--force`. The
cache is only an optimisation; `diagnostics.json` and `results.json`, which the
editor reads, stay.

`NAMESPACE_TESTS_DIR` moves it, which the library's own end-to-end test needs so
that a run inside a run does not write over what the outer one wrote. There is
no reason to set it otherwise.
