import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

// a webview is handed JSON, and decodes it with the codec the reporter encoded with
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
  // parse with the workspace's own TypeScript, the one the plugin runs
  alias: { "@typescript/typescript6": "./src/typescript.ts" },
  sourcemap: true,
  minify: process.argv.includes("--minify"),
  logLevel: "info",
});

// tsserver loads a plugin by package name from the extension's own node_modules,
// which a .vsix cannot carry: so it is built into dist/, and the extension puts
// it in node_modules when it activates (src/ts-plugin.ts), wherever it runs from.
// Its name is the one the extension contributes it under.
const PLUGIN = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
).contributes.typescriptServerPlugins[0].name;
const pluginDir = path.join(import.meta.dirname, "dist", "ts-plugin");
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "package.json"),
  JSON.stringify(
    { name: PLUGIN, version: "0.0.0", private: true, main: "index.js" },
    null,
    2,
  ),
);
await build({
  entryPoints: ["../ts-plugin/index.mts"],
  bundle: true,
  outfile: path.join(pluginDir, "index.js"),
  platform: "node",
  target: "node20",
  format: "cjs",
  // the printer reads the TypeScript tsserver hands the plugin: see ts-plugin/typescript.mts
  alias: { "@typescript/typescript6": "../ts-plugin/typescript.mts" },
  // the printer names files beside itself by `import.meta.url`, which a CommonJS bundle has not
  define: { "import.meta.url": "__nestsModuleUrl" },
  banner: {
    js: 'const __nestsModuleUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  // tsserver calls the module itself: `require(plugin)({ typescript })`
  footer: { js: "module.exports = module.exports.init;" },
  // no source map: dist/ts-plugin is copied whole into node_modules, and a .vsix leaves maps out
  minify: process.argv.includes("--minify"),
  logLevel: "info",
});
