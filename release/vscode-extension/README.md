# Namespace Tests

Type-level tests in the editor.

Every `export type X = Expect<…>` inside a `declare namespace Tests…` block
shows up as a test: in the Test Explorer, in the gutter, and as a lens above the
line you wrote it on. Running one runs exactly that one.

- **Run** — a single test, through Vitest, reported back at its own line. A file
  runs when you open or save it, and the lens shows where each test stands.
- **What Vitest sees** — at the top of a file with tests: your file diffed
  against the module Vitest is actually handed, which is your code plus the
  block that imports one generated test per `export type`.
- **Extract** — writes the test out as a real file beside the module it came
  from (`counter.Counter_Chainable.temp.ts`) and opens it: the part of your
  module the test needs, then the test.
- **Run · Debug · Delete · What Vitest sees** — at the top of an extracted
  file. The last diffs your copy against what a run actually serves for that
  test, where every first-party import carries the test's tag: a run gives each
  test its own copy of the modules it reaches, and a file can only hold one. So
  a table extracted into one file shares what a run would have kept apart —
  which is why the header says so when it can bite. *Run* is verbose,
  so every test in the file reports by name. *Debug* launches Vitest under the
  Node debugger on that one file, in a single process, with no test timeout, so
  a breakpoint you are sat on is not a failure. That is where you go to see what
  everything actually held. *Delete* closes the file's editor on the way out.
- **Failures** — clicking a failed lens opens the output with what the test
  expected against what it got, the line you wrote it on, and the frames from
  your own code. The frames from Vitest, chai and Node are dropped, as are the
  ones pointing into the generated test, since that module is served from
  memory and its path opens nothing.
- **Display** — on a test that names an HTML page
  (`Expect<…, "./chart.html">`): opens the page and hands it what the run saw,
  so a failing histogram is a chart rather than a wall of numbers. The page is
  yours — it announces itself with a `namespace-tests:ready` message and is sent
  `namespace-tests:result` with `actual`, `expected`, `passed`, `condition`,
  `message` and `meta`. Only JSON crosses into a webview, so the values travel
  encoded and are decoded in the page's own frame by the same codec that wrote
  them — a `Uint8Array`, a `Map` or a `bigint` arrives as itself. Re-running
  redraws whatever is open.
- **Diagnostics** — what the printer could not turn into a value, reported where
  you wrote it, before anything runs.

## About extracted files

They are yours. Edit them freely — nothing regenerates them behind your back,
and *Delete* asks first if what is in the file is no longer what was written
out. Extracting again over a file you have edited asks before overwriting.

They end in `.temp.ts`, which the plugin adds to Vitest's `include` so they run
like any other test file. Add `*.temp.ts` to your `.gitignore`.
