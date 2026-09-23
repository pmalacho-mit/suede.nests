// Bundle the extension. VS Code loads one file; `typescript` comes along for the
// parse that discovery does, and `vscode` is provided by the host.
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
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  logLevel: "info",
});
