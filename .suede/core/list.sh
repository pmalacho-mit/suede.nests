#!/usr/bin/env bash
#
# Every suede dependency in this repository, and what kind it is.
#
#   bash .suede/core/list.sh
#
#   KIND         ENTRY                      PATH                       PIN
#   release      my-app.widget              widget                     86abeeb
#   development  -                          fixtures/harness           4f10c2a
#   vendored     -                          release/mixin              9bb0e41
#
# The kind is read off the tree, the same way extract reads it: an install
# inside release/ is vendored; one that a root entry named <repo><sep><name>
# resolves to is a release dependency; anything else is development. suede's
# own vendored machinery (.suede/core, .github/workflows) is left out.

set -euo pipefail
LIB_PREFIX="list"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \?//'; exit 0; }
[[ "${1-}" == "-h" || "${1-}" == "--help" ]] && usage

lib_enter_root

DECLARED="$(release_dependencies 2>/dev/null || true)"
entry_for() { # <real path>
  local entry real
  while IFS=$'\t' read -r entry real; do
    [[ "$real" == "$1" ]] && { printf '%s' "$entry"; return; }
  done <<<"$DECLARED"
  printf '%s' "-"
}

rows=""
while IFS= read -r file; do
  dir="${file%/.gitrepo}"; dir="${dir#./}"
  case "$dir" in
    "$RELEASE_DIR") continue ;;                       # release/ itself
    .suede/core|*/.suede/core|.github/workflows|*/.github/workflows) continue ;;
  esac
  if [[ "$dir" == "$RELEASE_DIR"/* ]]; then
    kind="vendored"; entry="-"
  else
    entry="$(entry_for "$dir")"
    if [[ "$entry" == "-" ]]; then kind="development"; else kind="release"; fi
  fi
  rows+="$(printf '%-12s %-26s %-26s %s' "$kind" "$entry" "$dir" "$(short "$(field "$file" commit)")")"$'\n'
done < <(find . -name .gitrepo -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.worktrees/*' | sort)

if [[ -z "$rows" ]]; then
  echo "no suede dependencies found"
  exit 0
fi
printf '%-12s %-26s %-26s %s\n' KIND ENTRY PATH PIN
printf '%s' "$rows"
