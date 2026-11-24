// What a name in a test refers to, as the words describing a test need it:
// the JSDoc its declaration carries, and the names of its parameters.
import ts from "@typescript/typescript6";

import { docTextOf } from "../vite-plugin/emit/declarations.mts";

import type { Callee, Lookup } from "./shorthand.mts";

/** A symbol, through any imports, to what it was declared as. */
export const resolved = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
) =>
  symbol && symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;

/** Where a symbol is declared: its value's declaration, or else its first. */
export const declarationOf = (symbol: ts.Symbol | undefined) =>
  symbol?.valueDeclaration ?? symbol?.declarations?.[0];

/** Resolves names as written at the top of `source`: what the test's own names mean. */
export function lookupFor(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): Lookup {
  const cache = new Map<string, Callee | null>();
  return (name) => {
    if (cache.has(name)) return cache.get(name)!;
    const symbol = resolved(
      checker,
      checker.resolveName(
        name.split(".")[0]!,
        source,
        ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
        false,
      ),
    );
    const declaration = declarationOf(symbol);
    const found: Callee | null =
      symbol && declaration
        ? {
            doc: docTextOf(declaration),
            params:
              checker
                .getTypeOfSymbolAtLocation(symbol, declaration)
                .getCallSignatures()[0]
                ?.getParameters()
                .map((p) => p.getName()) ?? [],
          }
        : null;
    cache.set(name, found);
    return found;
  };
}
