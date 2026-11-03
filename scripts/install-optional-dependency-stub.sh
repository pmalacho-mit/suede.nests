#!/usr/bin/env bash
# install-optional-dependency-stub.sh
#
# Makes suede.nests an OPTIONAL dependency for the consumers of your library.
#
# Your code carries nest tests that `import type` from suede.nests'
# `dsl.import.meta.vitest`. Anyone who installs your library as source but not
# suede.nests would see that import fail to resolve. This script copies
# templates/optional/nests.d.ts into your library; it declares
# `*/dsl.import.meta.vitest` as an ambient module with loose types.
#
# TypeScript consults an ambient pattern module only when an import does not
# resolve to a file. So:
#   - nests absent:  imports fall back to the stub; the project type-checks and
#                    builds (tests are erased).
#   - nests present: the real types win; the stub is inert.
#
# Usage (from the library that carries the tests):
#   bash <path>/nests/scripts/install-optional-dependency-stub.sh <dest-dir>
#
# <dest-dir> must be inside what your tsconfig includes; it is created if
# missing. Commit the written `nests.d.ts`. Re-running overwrites it.
set -euo pipefail

dest="${1:-}"
if [[ -z "$dest" || "$dest" == -* ]]; then
  echo "usage: bash $0 <dest-dir>" >&2
  exit 1
fi

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../templates/optional" && pwd)/nests.d.ts"
[[ -f "$src" ]] || { echo "missing $src" >&2; exit 1; }

mkdir -p "$dest"
cp "$src" "$dest/nests.d.ts"
echo "installed $dest/nests.d.ts"
