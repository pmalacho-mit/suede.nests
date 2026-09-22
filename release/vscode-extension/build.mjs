// Bundle the extension. VS Code loads one file; `typescript` comes along for the
// parse that discovery does, and `vscode` is provided by the host.
import { build } from "esbuild";

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
