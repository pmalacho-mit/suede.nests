// Rendering a test's own display page.
//
// A test can name an HTML page to show its result on — a chart instead of a
// wall of numbers. The page is the author's, so it is loaded in an iframe and
// spoken to the way the page expects: it announces itself with
// `namespace-tests:ready`, and is handed `namespace-tests:result`. This module
// only builds the wrapper around it; the values come from the run.
import type { Expect, Invoke, Table } from "../../dsl.import.meta.vitest.ts";

/** What a display page is handed, once the run has something to show. */
export type DisplayResult = {
  /** What the test asserted on, decoded. */
  actual: unknown;
  /** What it was compared against. */
  expected: unknown;
  passed: boolean;
  /** The matcher chain, as the printer wrote it: `.toEqual([1, 2])`. */
  condition: string;
  /** The assertion error, when it failed. */
  message: string | null;
  /** `displayMeta` from the test's config, or null. */
  meta: unknown;
};

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A nonce, so the wrapper's one script can run under a strict policy. */
export const nonce = (random = Math.random) =>
  random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);

/**
 * The page in an iframe, plus the few lines that relay between it and the
 * extension: the page says it is ready, the extension sends the result, the
 * wrapper decodes it and passes it on. Nothing of the result is written into
 * this HTML — it arrives by message, and is decoded here rather than before
 * being sent, because only JSON crosses into a webview and the whole point of
 * the encoding is to carry what JSON cannot.
 */
export function wrapper(
  page: string,
  csp: string,
  codec: string,
  id = nonce(),
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${csp}; style-src 'unsafe-inline'; script-src 'nonce-${id}' ${csp};" />
  <style>
    html, body { height: 100%; margin: 0; }
    iframe { border: 0; width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <iframe id="page" src="${escape(page)}"></iframe>
  <script type="module" nonce="${id}">
    import { decode } from "${escape(codec)}";
    const vscode = acquireVsCodeApi();
    const page = document.getElementById("page");
    let result = null;
    let ready = false;
    const send = () => {
      if (ready && result) page.contentWindow.postMessage(result, "*");
    };
    // the page announces itself; the extension answers with what the run saw
    window.addEventListener("message", ({ data }) => {
      if (data?.type === "namespace-tests:ready") {
        ready = true;
        vscode.postMessage({ type: "ready" });
      } else if (data?.type === "namespace-tests:result") {
        // what crossed from the extension is JSON; the page gets the values back
        result = { ...data, actual: decode(data.actual), expected: decode(data.expected) };
        send();
      }
      send();
    });
    // a page that listens without announcing still gets its result
    page.addEventListener("load", () => {
      ready = true;
      vscode.postMessage({ type: "ready" });
    });
  </script>
</body>
</html>`;
}

declare namespace wrapper {
  type Html = Invoke<
    typeof wrapper,
    ["https://x/page.html", "https://x", "https://x/codec.js", "abc123"]
  >;

  /** the page is what is shown; the wrapper is only around it */
  export type Frames = Expect<
    Html,
    "includes",
    '<iframe id="page" src="https://x/page.html">'
  >;

  /** its own script runs by nonce, and nothing else may */
  export type Locked = Table<
    typeof wrapper,
    [
      [
        args: ["p.html", "https://x", "c.js", "abc123"],
        cond: "includes",
        expected: "script-src 'nonce-abc123' https://x;",
      ],
      [
        args: ["p.html", "https://x", "c.js", "abc123"],
        cond: "includes",
        expected: "frame-src https://x;",
      ],
      [
        args: ['"><script>alert(1)</script>', "https://x", "c.js", "abc123"],
        cond: "excludes",
        expected: "<script>alert(1)",
      ]
    ]
  >;
}
