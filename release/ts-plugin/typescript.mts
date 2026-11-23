// Stands in for "@typescript/typescript6" in the plugin's bundle (see the alias
// in release/vscode-extension/build.mjs): the printer then reads the very
// TypeScript tsserver runs, whose program the language service hands over, so
// every node it is given is one this copy made.
import type TS from "@typescript/typescript6";

// until tsserver hands its TypeScript over, any use says so
const notLoaded = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "namespace-tests: the TypeScript plugin was used before tsserver loaded it",
      );
    },
  },
);

// what the printer imports: its prototype becomes tsserver's TypeScript, so a lookup is a plain read
const ts = Object.create(notLoaded) as typeof TS;

/** The TypeScript tsserver loaded the plugin with. */
export const useTypeScript = (loaded: typeof TS) => {
  Object.setPrototypeOf(ts, loaded);
};

export default ts;
