// Bundle the extension. VS Code loads one file, and provides `vscode` itself.
//
// TypeScript is not bundled: discovery parses with the copy the library
// imports, so what the editor finds is what the plugin runs. `typescript` is
// aliased to a stand-in that resolves that copy on first use — which also keeps
// a 10MB compiler out of every TypeScript workspace the extension activates in.
//
// The codec is built a second time, for the browser: what reaches a webview is
// JSON, so a display page is handed the encoded form and decodes it there, with
// the same module the reporter encoded it with.
import { build } from "esbuild";

await build({
  entryPoints: ["../vite-plugin/codec.mts"],
  bundle: true,
  outfile: "dist/codec.js",
  platform: "browser",
  target: "es2022",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  alias: { typescript: "./src/typescript.ts" },
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  logLevel: "info",
});
