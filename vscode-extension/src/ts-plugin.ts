// The TypeScript plugin (release/ts-plugin) is loaded by tsserver by package
// name, from this extension's node_modules. A .vsix cannot carry node_modules
// (`vsce package --no-dependencies` leaves every file under it out), so the
// build writes the plugin to dist/ts-plugin, and the extension puts it where
// tsserver looks when it activates.
import fs from "node:fs";
import path from "node:path";

import type {
  Exists,
  Expect,
  FromFile,
  Given,
  Invoke,
  TempDir,
} from "../../dsl.import.meta.vitest.ts";

export const PLUGIN = "namespace-tests-ts-plugin";

const FILES = ["index.js", "package.json"];

const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Puts the built plugin in `<extension>/node_modules`, unless it is there as
 * built. True when it wrote it: tsserver then has to be restarted to load it.
 */
export function placeTypeScriptPlugin(extensionPath: string): boolean {
  const from = path.join(extensionPath, "dist", "ts-plugin");
  const to = path.join(extensionPath, "node_modules", PLUGIN);
  const built = FILES.map((f) => read(path.join(from, f)));
  if (built.some((text) => text === null)) return false;
  if (FILES.every((f, i) => read(path.join(to, f)) === built[i])) return false;
  fs.mkdirSync(to, { recursive: true });
  FILES.forEach((f, i) => fs.writeFileSync(path.join(to, f), built[i]!));
  return true;
}

declare namespace placeTypeScriptPlugin {
  type Built = TempDir<{
    "dist/ts-plugin/index.js": "plugin()";
    "dist/ts-plugin/package.json": "{}";
  }>;

  /** a fresh install is given the plugin where tsserver looks, and says tsserver must restart */
  export type FirstRun = Given<
    Invoke<typeof placeTypeScriptPlugin, [extensionPath: Built]>,
    Expect<
      FromFile<`${Built}/node_modules/namespace-tests-ts-plugin/index.js`>,
      "=",
      "plugin()"
    >
  >;

  export type Says = Expect<
    Invoke<typeof placeTypeScriptPlugin, [extensionPath: Built]>,
    "=",
    true
  >;

  /** once it is there as built, nothing is written and nothing restarts */
  export type AlreadyThere = Given<
    Invoke<typeof placeTypeScriptPlugin, [extensionPath: Built]>,
    Expect<
      Invoke<typeof placeTypeScriptPlugin, [extensionPath: Built]>,
      "=",
      false
    >
  >;

  type Unbuilt = TempDir;

  /** an extension with no plugin built has nothing to place */
  export type NotBuilt = Given<
    Invoke<typeof placeTypeScriptPlugin, [extensionPath: Unbuilt]>,
    Expect<Exists<`${Unbuilt}/node_modules`>, "falsy">
  >;
}
