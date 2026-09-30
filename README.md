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

## Documentation

- [The library's README](./release/README.md): setup, writing tests, mocking, extracting a test
- [API reference](./release/docs/API.md): every building block of the DSL, with examples
- [The editor extension](./release/vscode-extension/README.md)

## Importing the DSL — the path matters

Import the DSL from the file whose name contains `import.meta.vitest`, and use
that path in **every** file you write tests in:

```ts
import type { Expect, Invoke } from "./<path-to-library>/dsl.import.meta.vitest.ts";
```

That filename is load-bearing, not a joke. Vitest decides which files hold tests
by globbing `includeSource` and keeping the ones whose **raw text** contains the
string `import.meta.vitest` — the check really is a substring match on the bytes
it reads from disk, before any plugin runs. Importing the DSL by this path is
what puts that string in your file, and so is what makes your tests findable.

Two consequences worth knowing:

- **Re-exporting the DSL hides your tests.** If you wrap it in a barrel —
  `export type { Expect } from "./<path-to-library>/dsl.import.meta.vitest.ts"` — then
  the files importing *your* barrel no longer contain the marker, and they are
  silently never collected. Import the DSL directly in each file that has tests.
- **Always `import type`.** Vitest rewrites every occurrence of
  `import.meta.vitest` in a file it collects, including the one inside your
  import path. A type-only import is erased before that can matter; a value
  import from the same path would break.

## How a test is run

Nothing is written to disk. For a module with tests, the plugin appends a collector:

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

The plugin only runs under Vitest — `vite build` skips it — so no collector
reaches a build, and the namespaces are erased with the rest of your types. A
value you declare outside a namespace for tests to use is ordinary code, and a
build treats it like any other export.

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

## Developing

`release/` is the library, with its own `package.json` and lockfile; the root
holds this repository's tooling — the tests, the examples, the docs. One
`npm install` at the root installs both.

| Script                       | What it does                                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| `npm test`                   | the library's own tests, the examples, and `tests/`                     |
| `npm run typecheck`          | the library, the examples, and the editor extension                     |
| `npm run docs:api`           | regenerates [release/docs](./release/docs/API.md) from the DSL's JSDoc |
| `npm run cli -- <args>`      | the library's command line, as `node release/cli.mts <args>`            |
| `npm run install-extension`  | builds, packages and installs the editor extension                      |
| `npm run release <script>`   | any of `release/`'s own scripts                                         |
