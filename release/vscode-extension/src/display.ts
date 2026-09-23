// Rendering a test's own display page.
//
// A test can name an HTML page to show its result on — a chart instead of a
// wall of numbers. The page is the author's, and it *is* the webview: its HTML
// is read from disk and served as the webview's own document, with a few lines
// put in front of it. It is not nested in a frame of its own. A nested frame
// navigates to its page, and in an editor running in a browser those
// navigations never reach the files — only the webview's own fetches do, which
// is how everything else here arrives.
//
// The page's side of the contract: listen for `message` before it has finished
// loading, and it is handed `namespace-tests:result` once it has. Announcing
// itself with `namespace-tests:ready` is still understood, but not needed.
import type { Expect, Invoke } from "../../dsl.import.meta.vitest.ts";

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

/** A nonce, so the page's scripts — and nothing else — can run under a strict policy. */
export const nonce = (random = Math.random) =>
  random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);

/** Where what the page needs comes from, as the webview can reach it. */
export type Sources = {
  /** The page's own folder, so its stylesheets, scripts and images resolve. */
  base: string;
  /** The webview's resource origin, for the content security policy. */
  csp: string;
  /** The codec the values are decoded with. */
  codec: string;
};

/**
 * Tell the extension the page is ready — once, whichever comes first: the page
 * saying so, or its having loaded. Then decode what arrives and hand it on.
 *
 * The values travel encoded because only JSON crosses into a webview, which
 * cannot carry a `Map` or a `bigint`. They arrive as `namespace-tests:encoded`
 * and leave as `namespace-tests:result`, so this never hears its own message.
 */
const bootstrap = (codec: string) => `(() => {
  // An editor running in a browser hides \`window.parent\` from a webview, so a
  // page announcing itself the way it would from a frame throws. \`parent\` is
  // replaceable: pointing it at the page's own window makes the announcement
  // arrive here, and gives the page nothing it did not already have.
  if (!window.parent) {
    try { window.parent = window; } catch {}
    if (!window.parent)
      try { Object.defineProperty(window, "parent", { value: window, configurable: true }); } catch {}
  }
  const vscode = acquireVsCodeApi();
  const codec = import(${JSON.stringify(codec).replace(/</g, "\\u003c")});
  let announced = false;
  const announce = () => {
    if (announced) return;
    announced = true;
    vscode.postMessage({ type: "ready" });
  };
  window.addEventListener("message", async ({ data }) => {
    if (data?.type === "namespace-tests:ready") announce();
    else if (data?.type === "namespace-tests:encoded") {
      const { decode } = await codec;
      window.postMessage(
        { ...data, type: "namespace-tests:result", actual: decode(data.actual), expected: decode(data.expected) },
        "*",
      );
    }
  });
  window.addEventListener("load", announce);
})();`;

/**
 * The page, as the webview's document: a policy, a base for its relative URLs
 * and the bootstrap go first, and every script the page already has is given
 * the nonce — the page is trusted, but nothing slipped into it is.
 */
export function render(page: string, sources: Sources, id = nonce()): string {
  const policy = [
    "default-src 'none'",
    `img-src ${sources.csp} data: https:`,
    `font-src ${sources.csp}`,
    `style-src 'unsafe-inline' ${sources.csp}`,
    `script-src 'nonce-${id}' ${sources.csp}`,
    `connect-src ${sources.csp}`,
  ].join("; ");
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
    `<base href="${escape(sources.base.endsWith("/") ? sources.base : `${sources.base}/`)}" />`,
    `<script nonce="${id}">${bootstrap(sources.codec)}</script>`,
  ].join("\n");
  const trusted = page.replace(
    /<script\b(?![^>]*\bnonce=)/gi,
    `<script nonce="${id}"`,
  );
  // before anything else — a policy only binds what comes after it — but after
  // the doctype, which has to be first to keep the page out of quirks mode
  const doctype = /^\s*<!doctype[^>]*>/i.exec(trusted)?.[0] ?? "";
  return `${doctype}\n${head}\n${trusted.slice(doctype.length)}`;
}

declare namespace render {
  type Page = `<!doctype html>
<div id="chart"></div>
<script>window.addEventListener("message", () => {});</script>`;
  type Html = Invoke<
    typeof render,
    [
      Page,
      { base: "https://r/pages"; csp: "https://r"; codec: "https://r/codec.js" },
      "abc123",
    ]
  >;

  /** the page is the document — there is no frame for a browser to refuse */
  export type NotFramed = Expect<Html, "excludes", "<iframe">;

  /** the doctype stays first, so the page is not rendered in quirks mode */
  export type Doctype = Expect<Html, "startsWith", "<!doctype html>">;

  /** its relative URLs resolve against its own folder */
  export type Based = Expect<Html, "includes", '<base href="https://r/pages/" />'>;

  /** its own scripts run, by the nonce they are given */
  export type Trusted = Expect<
    Html,
    "includes",
    '<script nonce="abc123">window.addEventListener'
  >;

  /** and only those: nothing without the nonce may */
  export type Locked = Expect<
    Html,
    "includes",
    "script-src 'nonce-abc123' https://r;"
  >;

  /**
   * an editor in a browser hides `window.parent` from a webview; a page that
   * announces itself through it is given its own window to announce to
   */
  export type Parent = Expect<
    Html,
    "includes",
    "if (!window.parent) {"
  >;

  /** a base that would break out of its attribute cannot */
  export type Escaped = Expect<
    Invoke<
      typeof render,
      [
        "<p></p>",
        { base: '"><script>alert(1)</script>'; csp: "x"; codec: "x" },
        "abc123",
      ]
    >,
    "excludes",
    "<script>alert(1)"
  >;
}
