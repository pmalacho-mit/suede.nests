// Namespace tests, in the editor.
//
// Open a file and its tests run. Each one says what it is doing on the line it
// was written on — running, passed, failed — and can be *extracted*: the test
// it compiles to, written out beside the module as a real file you can run,
// debug and edit. The extension never interprets the DSL: it finds names and lines,
// runs Vitest, and shows what came back.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { discover, hasTests, nameKey, testFilter } from "./discovery.js";
import { findLibrary, forgetLibrary, type Library } from "./library.js";
import { wrapper } from "./display.js";
import { SUFFIX, extract, extracted, tempPathFor } from "./extract.js";
import { explain } from "./failure.js";

const ID = "namespace-tests";

/**
 * Everything the library derives from your source lives in its own folder, not
 * in the project. `null` when there is no library to ask.
 */
const DERIVED = ".derived";

/** Where Node keeps the compiled form of what these commands load. */
let compiledModules: string | undefined;

/** The scheme the right-hand side of the "what Vitest sees" diff is served on. */
const COLLECTOR = `${ID}-collector`;
const collectors = new Map<string, string>();
const onCollectorChange = new vscode.EventEmitter<vscode.Uri>();
const derivedIn = (folder: string) => {
  const library = findLibrary(folder);
  return library ? path.join(library.root, DERIVED) : null;
};

type Outcome =
  | { state: "running" }
  | { state: "passed"; duration: number }
  | { state: "skipped" }
  | { state: "failed"; message: string };

export function activate(context: vscode.ExtensionContext): void {
  // Node's compiled-module cache goes in this extension's own storage, not in
  // anyone's repository: it belongs to this extension's copy of nothing in
  // particular, and leaving files in a project that no one asked for is rude.
  compiledModules = path.join(context.globalStorageUri.fsPath, "node");
  const controller = vscode.tests.createTestController(ID, "Namespace Tests");
  const diagnostics = vscode.languages.createDiagnosticCollection(ID);
  const output = vscode.window.createOutputChannel("Namespace Tests");
  context.subscriptions.push(controller, diagnostics, output);

  /** What each test is doing, keyed by test id. Drives the lenses. */
  const outcomes = new Map<string, Outcome>();
  /** What the last run saw for a test with a display page, keyed by test id. */
  const displays = new Map<string, Recorded>();
  /** Display panels on screen, so a re-run redraws what is already open. */
  const panels = new Map<string, vscode.WebviewPanel>();
  const lensesChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(lensesChanged);

  const idFor = (uri: vscode.Uri, name: string) => `${uri.toString()}::${name}`;

  // ── discovery ───────────────────────────────────────────────────────────
  const load = (uri: vscode.Uri, text?: string) => {
    let source: string;
    try {
      source = text ?? fs.readFileSync(uri.fsPath, "utf8");
    } catch {
      return [];
    }
    if (!hasTests(source)) {
      controller.items.delete(uri.toString());
      return [];
    }
    const tests = discover(uri.fsPath, source);
    const file =
      controller.items.get(uri.toString()) ??
      controller.createTestItem(
        uri.toString(),
        vscode.workspace.asRelativePath(uri),
        uri,
      );
    controller.items.add(file);
    file.children.replace(
      tests.map((test) => {
        const item = controller.createTestItem(
          idFor(uri, test.name),
          test.name,
          uri,
        );
        item.range = new vscode.Range(
          test.line,
          test.column,
          test.line,
          test.column + test.length,
        );
        return item;
      }),
    );
    return tests;
  };

  controller.resolveHandler = async (item) => {
    if (item?.uri) return void load(item.uri);
    for (const uri of await vscode.workspace.findFiles(
      "**/*.{ts,tsx,mts,cts}",
      "**/node_modules/**",
    ))
      load(uri);
  };

  // ── running ─────────────────────────────────────────────────────────────
  const itemsOf = (uri: vscode.Uri) => {
    const file = controller.items.get(uri.toString());
    const items: vscode.TestItem[] = [];
    file?.children.forEach((child) => items.push(child));
    return items;
  };

  /**
   * One Vitest run, reported to both surfaces: the Test Explorer and the
   * lenses. `only` narrows it to a single test.
   */
  const runTests = async (uri: vscode.Uri, only?: vscode.TestItem) => {
    const items = only ? [only] : itemsOf(uri);
    if (!items.length) return;
    const run = controller.createTestRun(
      new vscode.TestRunRequest(items),
      undefined,
      false,
    );
    for (const item of items) {
      outcomes.set(item.id, { state: "running" });
      run.started(item);
    }
    lensesChanged.fire();

    const started = Date.now();
    try {
      const { assertions: report, details } = await vitest(uri, only?.label, output);
      const duration = Math.round((Date.now() - started) / Math.max(items.length, 1));
      for (const item of items) {
        // by key, not by spelling: the names came back from whichever version
        // of the library the workspace has
        const wanted = nameKey(item.label);
        const assertions = report.filter(
          (a) =>
            nameKey(a.title) === wanted || nameKey(a.title).startsWith(`${wanted}[`),
        );
        if (!assertions.length) {
          // Vitest ran, and had nothing to say about this test: the project's
          // config does not collect this file.
          outcomes.set(item.id, { state: "skipped" });
          run.skipped(item);
          if (!report.length)
            output.appendLine(
              `${vscode.workspace.asRelativePath(uri)} has tests, but this project's Vitest config does not collect it — check \`test.includeSource\` and the plugin's \`exclude\`.`,
            );
          continue;
        }
        // a table's rows are several assertions; the first with a page wins
        const shown = assertions
          .map((a) => details.get(a.title)?.display)
          .find(Boolean);
        if (shown) displays.set(item.id, shown);
        const failed = assertions.filter((a) => a.status === "failed");
        if (failed.length) {
          const message = failed
            .map((a) => {
              const detail = details.get(a.title);
              if (detail?.message) return explain({ name: a.title, ...detail });
              // no library to ask: Vitest's own message, then its frames
              const [first = "failed", ...rest] = (
                a.failureMessages?.[0] ?? "failed"
              ).split("\n");
              return explain({ name: a.title, message: first, stack: rest.join("\n") });
            })
            .join("\n\n" + "─".repeat(60) + "\n\n");
          outcomes.set(item.id, { state: "failed", message });
          run.failed(item, new vscode.TestMessage(message), duration);
        } else if (assertions.every((a) => a.status === "passed")) {
          outcomes.set(item.id, { state: "passed", duration });
          run.passed(item, duration);
        } else {
          outcomes.set(item.id, { state: "skipped" });
          run.skipped(item);
        }
      }
    } catch (error) {
      output.appendLine(String(error));
      for (const item of items) {
        outcomes.delete(item.id);
        run.errored(item, new vscode.TestMessage(String(error)));
      }
    } finally {
      run.end();
      lensesChanged.fire();
      for (const id of panels.keys()) void send(id);
    }
  };

  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request) => {
      const files = new Set<string>();
      const walk = (item: vscode.TestItem) =>
        item.children.size ? item.children.forEach(walk) : files.add(item.uri!.toString());
      if (request.include) request.include.forEach(walk);
      else controller.items.forEach(walk);
      for (const file of files) await runTests(vscode.Uri.parse(file));
    },
    true,
  );

  // ── the lens on the line ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "typescript", scheme: "file" },
        { language: "typescriptreact", scheme: "file" },
      ],
      {
        onDidChangeCodeLenses: lensesChanged.event,
        provideCodeLenses(document) {
          const text = document.getText();
          if (!hasTests(text)) return [];
          const tests = discover(document.uri.fsPath, text);
          const top: vscode.CodeLens[] = tests.length
            ? [
                new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
                  title: `$(diff) What Vitest sees (${tests.length} test${tests.length === 1 ? "" : "s"})`,
                  command: `${ID}.showCollector`,
                  arguments: [document.uri],
                }),
              ]
            : [];
          return top.concat(tests.flatMap((test) => {
            const range = new vscode.Range(
              test.line,
              test.column,
              test.line,
              test.column + test.length,
            );
            const id = idFor(document.uri, test.name);
            const outcome = outcomes.get(id);
            const lenses = [
              new vscode.CodeLens(range, {
                title: describe(outcome),
                command: outcome?.state === "failed" ? `${ID}.showFailure` : `${ID}.runTest`,
                arguments: [id],
              }),
              new vscode.CodeLens(range, {
                title: "$(go-to-file) Extract",
                command: `${ID}.extract`,
                arguments: [id],
              }),
              ...(test.display
                ? [
                    new vscode.CodeLens(range, {
                      title: "$(graph) Display",
                      command: `${ID}.display`,
                      arguments: [id],
                    }),
                  ]
                : []),
            ];
            if (outcome?.state === "failed")
              lenses.push(
                new vscode.CodeLens(range, {
                  title: "$(refresh) Run again",
                  command: `${ID}.runTest`,
                  arguments: [id],
                }),
              );
            return lenses;
          }));
        },
      },
    ),
  );

  /**
   * Hand a page what the run saw, still encoded: what crosses into a webview is
   * JSON, which cannot carry a `Map` or a `bigint` — so the page's frame
   * decodes it with the same codec the reporter encoded it with.
   */
  const send = async (id: string) => {
    const panel = panels.get(id);
    const recorded = displays.get(id);
    if (!panel || !recorded) return;
    await panel.webview.postMessage({
      type: "namespace-tests:result",
      actual: recorded.actual,
      expected: recorded.expected,
      passed: recorded.passed,
      condition: recorded.condition,
      message: recorded.message,
      meta: recorded.meta ?? null,
    });
  };

  // ── commands ────────────────────────────────────────────────────────────
  const itemById = (id: string) => {
    let found: vscode.TestItem | undefined;
    const search = (item: vscode.TestItem) => {
      if (found) return;
      if (item.id === id) found = item;
      else item.children.forEach(search);
    };
    controller.items.forEach(search);
    return found;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(`${ID}.runTest`, async (id: string) => {
      const item = itemById(id);
      if (item?.uri) await runTests(item.uri, item);
    }),

    vscode.commands.registerCommand(`${ID}.showFailure`, async (id: string) => {
      const outcome = outcomes.get(id);
      if (outcome?.state !== "failed") return;
      output.clear();
      output.appendLine(outcome.message);
      output.show(true);
    }),

    /**
     * Write the test out as a file of its own, beside the module it came from,
     * and open it. From there it is an ordinary test file: run it, debug it,
     * edit it, throw it away.
     */
    vscode.commands.registerCommand(`${ID}.extract`, async (from?: vscode.TestItem | string) => {
      const item = typeof from === "string" ? itemById(from) : from;
      if (!item?.uri) return;
      const target = tempPathFor(item.uri.fsPath, item.label);
      const relative = vscode.workspace.asRelativePath(item.uri);

      if (fs.existsSync(target)) {
        const mine = extracted(contentsOf(vscode.Uri.file(target)));
        if (!mine || mine.edited) {
          const answer = await vscode.window.showWarningMessage(
            `${path.basename(target)} has changes that were not generated.`,
            { modal: true },
            "Open it",
            "Overwrite",
          );
          if (answer !== "Overwrite") {
            if (answer === "Open it") await open(target);
            return;
          }
        }
      }

      let body: string;
      try {
        body = await minimal(item.uri, item.label, output);
      } catch (error) {
        output.appendLine(String(error));
        output.show(true);
        void vscode.window.showErrorMessage(
          `Could not generate ${item.label}. See the Namespace Tests output.`,
        );
        return;
      }
      fs.writeFileSync(target, extract(relative, item.label, body));
      await open(target);
    }),

    /**
     * A test's own page, showing what the run saw. The page is the author's —
     * it is handed the values and draws them however it likes — so this only
     * runs the test if nothing has been recorded yet, and opens it.
     */
    vscode.commands.registerCommand(`${ID}.display`, async (from?: vscode.TestItem | string) => {
      const item = typeof from === "string" ? itemById(from) : from;
      if (!item?.uri) return;
      if (!displays.has(item.id)) await runTests(item.uri, item);
      const recorded = displays.get(item.id);
      if (!recorded) {
        void vscode.window.showWarningMessage(
          `${item.label} recorded nothing to display. Does its page exist, and did the test run?`,
        );
        return;
      }
      const page = vscode.Uri.joinPath(
        vscode.Uri.file(path.dirname(item.uri.fsPath)),
        recorded.display,
      );
      if (!fs.existsSync(page.fsPath)) {
        void vscode.window.showErrorMessage(
          `${item.label} names a display page that is not there: ${recorded.display}`,
        );
        return;
      }
      const existing = panels.get(item.id);
      const panel =
        existing ??
        vscode.window.createWebviewPanel(
          `${ID}.display`,
          item.label,
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            // the page's own folder, so its stylesheets and images resolve —
            // and this extension's, for the codec the page decodes with
            localResourceRoots: [
              vscode.Uri.file(path.dirname(page.fsPath)),
              vscode.Uri.joinPath(context.extensionUri, "dist"),
            ],
          },
        );
      if (!existing) {
        panels.set(item.id, panel);
        panel.onDidDispose(() => panels.delete(item.id));
        // the page announces itself when it is ready for the values
        panel.webview.onDidReceiveMessage(() => void send(item.id));
      }
      panel.webview.html = wrapper(
        panel.webview.asWebviewUri(page).toString(),
        panel.webview.cspSource,
        panel.webview
          .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "codec.js"))
          .toString(),
      );
      panel.reveal(panel.viewColumn, true);
      await send(item.id);
    }),

    /**
     * What Vitest is handed for this file: your code, plus the block that pulls
     * in the generated tests. Shown against the file itself, so the addition is
     * the whole of the difference.
     */
    vscode.commands.registerCommand(`${ID}.showCollector`, async (uri: vscode.Uri) => {
      let text: string;
      try {
        text = await collector(uri, output);
      } catch (error) {
        output.appendLine(String(error));
        output.show(true);
        void vscode.window.showErrorMessage(
          `Could not read what Vitest sees for ${path.basename(uri.fsPath)}. See the Namespace Tests output.`,
        );
        return;
      }
      collectors.set(uri.fsPath, text);
      const right = uri.with({ scheme: COLLECTOR, query: `${Date.now()}` });
      onCollectorChange.fire(right);
      await vscode.commands.executeCommand(
        "vscode.diff",
        uri,
        right,
        `${path.basename(uri.fsPath)} ↔ what Vitest sees`,
        { preview: true },
      );
    }),

    /** The extracted file, run the way anyone would run a test file. */
    vscode.commands.registerCommand(`${ID}.runExtracted`, (uri: vscode.Uri) => {
      const cwd = folderOf(uri);
      const terminal =
        vscode.window.terminals.find((t) => t.name === "Namespace Tests") ??
        vscode.window.createTerminal({ name: "Namespace Tests", cwd });
      terminal.show(true);
      // verbose: every test in the file, named, with its own result
      terminal.sendText(
        `npx vitest run ${quoteArg(path.relative(cwd, uri.fsPath))} --reporter=verbose`,
      );
    }),

    /**
     * The same run, under the debugger: breakpoints in the test and in the code
     * it exercises both hit, which is where the values are.
     */
    vscode.commands.registerCommand(`${ID}.debugExtracted`, async (uri: vscode.Uri) => {
      const cwd = folderOf(uri);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const relative = path.relative(cwd, uri.fsPath);
      const started = await vscode.debug.startDebugging(folder, {
        type: "node",
        request: "launch",
        name: `Debug ${path.basename(relative)}`,
        cwd,
        program: path.join(cwd, "node_modules", "vitest", "vitest.mjs"),
        // one process, no timeout: a breakpoint that is sat on is not a failure
        args: ["run", relative, "--no-file-parallelism", "--testTimeout=0"],
        autoAttachChildProcesses: true,
        console: "integratedTerminal",
        smartStep: true,
        skipFiles: ["<node_internals>/**"],
      });
      if (!started)
        void vscode.window.showErrorMessage(
          `Could not start a debug session for ${path.basename(relative)}.`,
        );
    }),

    /**
     * What a run makes of the test this file came from. A file holds one
     * module; a run serves each test its own, with every first-party import
     * carrying that test's tag — which is the difference an extracted file
     * flattens, and the reason several tests in one of them share state.
     */
    vscode.commands.registerCommand(`${ID}.showServed`, async (uri: vscode.Uri) => {
      const mine = extracted(contentsOf(uri));
      if (!mine) return;
      const origin = vscode.Uri.file(
        path.resolve(folderOf(uri), mine.source),
      );
      let text: string;
      try {
        text = await served(origin, mine.test, output);
      } catch (error) {
        output.appendLine(String(error));
        output.show(true);
        void vscode.window.showErrorMessage(
          `Could not read what Vitest runs for ${mine.test}. See the Namespace Tests output.`,
        );
        return;
      }
      collectors.set(uri.fsPath, text);
      const right = uri.with({ scheme: COLLECTOR, query: `${Date.now()}` });
      onCollectorChange.fire(right);
      await vscode.commands.executeCommand(
        "vscode.diff",
        uri,
        right,
        `${path.basename(uri.fsPath)} ↔ what Vitest runs`,
        { preview: true },
      );
    }),

    /** Throw it away — asking first if it is no longer what was generated. */
    vscode.commands.registerCommand(`${ID}.deleteExtracted`, async (uri: vscode.Uri) => {
      const mine = extracted(contentsOf(uri));
      if (!mine || mine.edited) {
        const answer = await vscode.window.showWarningMessage(
          `${path.basename(uri.fsPath)} has changes that were not generated. Delete it?`,
          { modal: true },
          "Delete",
        );
        if (answer !== "Delete") return;
      }
      // close it first, or its editor is left behind showing a file that is gone
      await closeEditorsFor(uri);
      await vscode.workspace.fs.delete(uri);
    }),
  );

  // ── the right-hand side of that diff ────────────────────────────────────
  context.subscriptions.push(
    onCollectorChange,
    vscode.workspace.registerTextDocumentContentProvider(COLLECTOR, {
      onDidChange: onCollectorChange.event,
      provideTextDocumentContent: (uri) => collectors.get(uri.fsPath) ?? "",
    }),
  );

  // ── the lenses on an extracted file ─────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "typescript", scheme: "file", pattern: `**/*${SUFFIX}` },
      {
        provideCodeLenses(document) {
          const mine = extracted(document.getText());
          if (!mine) return [];
          const top = new vscode.Range(0, 0, 0, 0);
          const actions: [title: string, command: string][] = [
            ["$(play) Run", `${ID}.runExtracted`],
            ["$(debug-alt) Debug", `${ID}.debugExtracted`],
            ["$(trash) Delete", `${ID}.deleteExtracted`],
            ["$(diff) What Vitest sees", `${ID}.showServed`],
          ];
          return actions.map(
            ([title, command]) =>
              new vscode.CodeLens(top, { title, command, arguments: [document.uri] }),
          );
        },
      },
    ),
  );

  // ── what the printer could not materialise ──────────────────────────────
  const publishDiagnostics = (folder: vscode.WorkspaceFolder) => {
    const derived = derivedIn(folder.uri.fsPath);
    if (!derived) return;
    const file = path.join(derived, "diagnostics.json");
    if (!fs.existsSync(file)) return;
    let byFile: Record<string, Warning[]>;
    try {
      byFile = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return; // written while we were reading it; the watcher will fire again
    }
    for (const [relative, warnings] of Object.entries(byFile))
      diagnostics.set(
        vscode.Uri.file(path.join(folder.uri.fsPath, relative)),
        warnings.map((w) => {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(w.line, w.column, w.line, w.column + w.length),
            w.message,
            vscode.DiagnosticSeverity.Warning,
          );
          diagnostic.source = ID;
          return diagnostic;
        }),
      );
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    publishDiagnostics(folder);
    const derived = derivedIn(folder.uri.fsPath);
    if (!derived) continue;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(derived), "diagnostics.json"),
    );
    const refresh = () => publishDiagnostics(folder);
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    context.subscriptions.push(watcher);
  }

  // ── open a file, and it tells you where it stands ───────────────────────
  const autoRun = (document: vscode.TextDocument) => {
    if (document.uri.scheme !== "file") return;
    const tests = load(document.uri, document.getText());
    if (!tests.length) return;
    if (!vscode.workspace.getConfiguration(ID).get<boolean>("autoRun", true))
      return;
    void runTests(document.uri);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(autoRun),
    vscode.workspace.onDidSaveTextDocument(autoRun),
    // an edit changes where the tests are, but not what they last did
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      load(e.document.uri, e.document.getText());
      lensesChanged.fire();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(forgetLibrary),
  );

  void controller.resolveHandler(undefined);
  for (const document of vscode.workspace.textDocuments) autoRun(document);
}

export function deactivate(): void {}

type Warning = { line: number; column: number; length: number; message: string };
type Assertion = { title: string; status: string; failureMessages?: string[] };

const describe = (outcome: Outcome | undefined) => {
  if (!outcome) return "$(play) Run";
  if (outcome.state === "running") return "$(sync~spin) Running…";
  if (outcome.state === "passed") return `$(check) Passed (${outcome.duration}ms)`;
  if (outcome.state === "skipped") return "$(circle-slash) Skipped";
  return "$(error) Failed";
};

/**
 * Close every editor showing a file, so deleting it does not leave a tab behind
 * on something that is gone. A tab with unsaved changes is reverted rather than
 * closed, which is what skips the "do you want to save?" prompt — the answer is
 * already no, the file is being deleted.
 */
const closeEditorsFor = async (uri: vscode.Uri) => {
  for (const group of vscode.window.tabGroups.all)
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      if (tab.input.uri.fsPath !== uri.fsPath) continue;
      if (!tab.isDirty) {
        await vscode.window.tabGroups.close(tab);
        continue;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        viewColumn: group.viewColumn,
        preview: false,
      });
      await vscode.commands.executeCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }
};

/**
 * What is in a file now: an open editor with unsaved changes is the truth, not
 * what was last written to disk.
 */
const contentsOf = (uri: vscode.Uri) => {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.fsPath === uri.fsPath,
  );
  if (open) return open.getText();
  try {
    return fs.readFileSync(uri.fsPath, "utf8");
  } catch {
    return "";
  }
};

/** Open a file in the editor, beside whatever is already there. */
const open = async (file: string) => {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
  });
};

/** A path, as a shell would have to read it. */
const quoteArg = (value: string) =>
  /^[\w./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;

/**
 * How a file beside `source` would import the library's runtime — the plugin
 * computes the same string for the test module it serves. A library inside
 * `node_modules` is imported by name instead, so there is nothing to pass.
 */
const runtimeSpecifier = (library: Library, source: string) => {
  if (library.runtime.includes(`${path.sep}node_modules${path.sep}`)) return null;
  const rel = path
    .relative(path.dirname(source), library.runtime)
    .split(path.sep)
    .join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

const folderOf = (uri: vscode.Uri) =>
  vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);

/**
 * What the library's own reporter recorded about a test, which is more than
 * Vitest's JSON report carries: the diff of expected against received, and the
 * line of the `export type` it came from.
 */
type Detail = {
  message: string;
  diff: string | null;
  where: string | null;
  stack: string | null;
  /** What a test with a display page recorded, as the reporter encoded it. */
  display: Recorded | null;
};

/** One `ntCheck` payload, straight out of results.json. */
type Recorded = {
  display: string;
  meta: unknown;
  condition: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
  message: string | null;
};

/** Run a file's tests, or one of them, and hand back what Vitest reported. */
async function vitest(
  uri: vscode.Uri,
  only: string | undefined,
  output: vscode.OutputChannel,
): Promise<{ assertions: Assertion[]; details: Map<string, Detail> }> {
  const cwd = folderOf(uri);
  const outputFile = path.join(
    os.tmpdir(),
    `namespace-tests-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  // The library's own reporter, alongside the JSON one: it is what knows the
  // diff. A workspace without the library still runs, just with less to say.
  const library = findLibrary(cwd);
  const sidecar = library
    ? path.join(library.root, DERIVED, "results.json")
    : "";
  const reporter = library?.reporter;
  if (reporter) fs.rmSync(sidecar, { force: true }); // never read a stale run

  const args = [
    "vitest",
    "run",
    path.relative(cwd, uri.fsPath),
    "--reporter=json",
    `--outputFile=${outputFile}`,
    ...(reporter ? [`--reporter=${reporter}`] : []),
    ...(only ? ["-t", testFilter(only)] : []),
  ];

  const result = await exec("npx", args, cwd);
  if (!fs.existsSync(outputFile)) {
    output.appendLine(`npx ${args.join(" ")}`);
    output.appendLine(result.stderr || result.stdout);
    throw new Error("Vitest produced no report");
  }
  try {
    const report = JSON.parse(fs.readFileSync(outputFile, "utf8")) as {
      testResults?: { assertionResults?: Assertion[] }[];
    };
    return {
      assertions: (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []),
      details: detailsFrom(sidecar),
    };
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
}

/** What the library's reporter left behind, by test name. */
function detailsFrom(file: string): Map<string, Detail> {
  const details = new Map<string, Detail>();
  let records: ResultRecord[];
  try {
    records = (JSON.parse(fs.readFileSync(file, "utf8")) as { results?: ResultRecord[] })
      .results ?? [];
  } catch {
    return details; // no library, or nothing written: the JSON report still stands
  }
  for (const record of records) {
    const error = record.errors?.[0];
    const shown = record.displays?.[0];
    if (!error && !shown) continue;
    details.set(record.name, {
      message: error?.message ?? "",
      diff: error?.diff ?? null,
      where: record.location ? `${record.file}:${record.location.line}` : null,
      stack: error?.stack ?? null,
      // still encoded here: decoding needs the library, which is loaded only
      // when a page is actually opened
      display: shown ?? null,
    });
  }
  return details;
}

/** The part of the library's results.json this reads. */
type ResultRecord = {
  name: string;
  file: string;
  location: { line: number } | null;
  errors?: { message: string; diff: string | null; stack: string | null }[];
  displays?: Recorded[];
};

/** The library's own minimal reproduction, from wherever it is installed. */
/**
 * Ask the library about a file. `what` is the test to print, or `--collector`
 * for the module Vitest is handed. Either way the answer usually comes from
 * what a run already printed, which is why this is worth doing on a click.
 */
async function ask(
  uri: vscode.Uri,
  what: string,
  output: vscode.OutputChannel,
  extra: string[] = [],
): Promise<string> {
  const cwd = folderOf(uri);
  const configured = vscode.workspace
    .getConfiguration(ID)
    .get<string>("minimalCommand", "");
  const file = path.relative(cwd, uri.fsPath);

  const library = findLibrary(cwd);
  const [command, args] = configured
    ? [
        configured.split(" ")[0]!,
        [...configured.split(" ").slice(1), file, what],
      ]
    : (() => {
        if (!library)
          throw new Error(
            "Could not find dsl.import.meta.vitest.ts in this workspace; set namespace-tests.minimalCommand",
          );
        // The same specifier the plugin gives a generated test, so this asks
        // for exactly what a run already printed and cached — and so that an
        // extracted test importing the runtime resolves from where it is written.
        const runtime = runtimeSpecifier(library, uri.fsPath);
        return [
          "node",
          [
            library.minimal,
            file,
            what,
            ...extra,
            ...(runtime ? ["--runtime", runtime] : []),
          ],
        ] as const;
      })();

  // Node keeps the compiled form of what it loads in this extension's own
  // storage: most of a cold run is parsing ~10MB of TypeScript.
  const result = await exec(
    command,
    [...args],
    cwd,
    compiledModules ? { NODE_COMPILE_CACHE: compiledModules } : {},
  );
  if (!result.stdout.trim()) {
    output.appendLine(`${command} ${args.join(" ")}`);
    output.appendLine(result.stderr || "(no output)");
    throw new Error(`No generated source for ${what}`);
  }
  return result.stdout;
}

/** One test, as a file that can stand on its own. */
const minimal = (
  uri: vscode.Uri,
  name: string,
  output: vscode.OutputChannel,
) => ask(uri, name, output);

/** The whole file, as Vitest is handed it. */
const collector = (uri: vscode.Uri, output: vscode.OutputChannel) =>
  ask(uri, "--collector", output);

/** One test, as a run serves it: forked imports and all. */
const served = (
  uri: vscode.Uri,
  name: string,
  output: vscode.OutputChannel,
) => ask(uri, name, output, ["--served"]);

function exec(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // a failing test exits non-zero, which is a result, not an error
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
