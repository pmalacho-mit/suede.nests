# Typescript Namespace Tests Suede

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede). 

To see the installable source code, please checkout the [release branch](https://github.com/pmalacho-mit/typescript-namespace-tests-suede/tree/release).

## Installation

```bash
bash <(curl -fsSL https://suede.sh/install/release) --repo pmalacho-mit/typescript-namespace-tests-suede
```

<details>
<summary>
See alternative to using <a href="https://github.com/pmalacho-mit/suede#suedesh">suede.sh</a> script proxy
</summary>

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pmalacho-mit/suede/refs/heads/main/scripts/install/release.sh) --repo pmalacho-mit/typescript-namespace-tests-suede
```

</details>

## Importing the DSL — the path matters

Import the DSL from the file whose name contains `import.meta.vitest`, and use
that path in **every** file you write tests in:

```ts
// vendored beside your code
import type { Expect, Invoke } from "./namespace-testing/dsl.import.meta.vitest.ts";

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
  the files importing *your* barrel no longer contain the marker, and they are
  silently never collected. Import the DSL directly in each file that has tests.
- **Always `import type`.** Vitest rewrites every occurrence of
  `import.meta.vitest` in a file it collects, including the one inside your
  import path. A type-only import is erased before that can matter; a value
  import from the same path would break.

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
module of yours is *meant* to be singular — a connection pool, a registry —
name it and every test will share one instance:

```ts
namespaceTests({ noIsolateModuleImport: ["src/db/**", "src/registry.ts"] })
```

Those are globs matched against each module's path relative to the project
root, the same shape as Vitest's own `include`. They name *modules*, not the
specifiers that import them, so one entry covers a module however its importers
happen to spell the path — `./registry.ts` from a sibling and
`../../registry.ts` from further down are the same module, and one pattern
catches both.
