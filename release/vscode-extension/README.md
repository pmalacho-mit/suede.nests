# Namespace Tests

Type-level tests in the editor.

Every `export type X = Expect<…>` inside a `declare namespace Tests…` block
shows up as a test: in the Test Explorer, in the gutter, and as a lens above the
line you wrote it on. Running one runs exactly that one.

- **Run** — a single test, through Vitest, reported back at its own line. A file
  runs when you open or save it, and the lens shows where each test stands.
- **Extract** — writes the test out as a real file beside the module it came
  from (`counter.Counter_Chainable.temp.ts`) and opens it: the part of your
  module the test needs, then the test.
- **Run · Debug · Delete** — at the top of an extracted file. *Run* is verbose,
  so every test in the file reports by name. *Debug* launches Vitest under the
  Node debugger on that one file, in a single process, with no test timeout, so
  a breakpoint you are sat on is not a failure. That is where you go to see what
  everything actually held. *Delete* closes the file's editor on the way out.
- **Failures** — clicking a failed lens opens the output with what the test
  expected against what it got, the line you wrote it on, and the frames from
  your own code. The frames from Vitest, chai and Node are dropped, as are the
  ones pointing into the generated test, since that module is served from
  memory and its path opens nothing.
- **Diagnostics** — what the printer could not turn into a value, reported where
  you wrote it, before anything runs.

## About extracted files

They are yours. Edit them freely — nothing regenerates them behind your back,
and *Delete* asks first if what is in the file is no longer what was written
out. Extracting again over a file you have edited asks before overwriting.

They end in `.temp.ts`, which the plugin adds to Vitest's `include` so they run
like any other test file. Add `*.temp.ts` to your `.gitignore`.
