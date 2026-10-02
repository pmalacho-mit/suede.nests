#!/usr/bin/env bash
#
# Every release dependency that differs from the commit its .gitrepo names.
# Non-empty output means "this pointer is dishonest": you would ship a pointer
# to code that is not what you built against.
#
#   bash .suede/core/diff.sh
#
# Each one is checked with the `diff` that ships in release/.suede/core, so
# this and a consumer's view of the same dependency cannot disagree. Vendored
# dependencies are exempt: one exists precisely *because* it diverges, and it
# ships as source. Development dependencies ship nothing and are exempt too.
#
# Exit 0 when every release dependency matches its pin, 1 when one does not,
# 2 when a comparison could not run.

set -euo pipefail
LIB_PREFIX="diff"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \?//'; exit 0; }
[[ "${1-}" == "-h" || "${1-}" == "--help" ]] && usage

lib_enter_root
DIFF="$(release_tool diff)"

DIVERGED=0; FAILED=0; COUNT=0
while IFS=$'\t' read -r entry real; do
  [[ -n "$entry" ]] || continue
  COUNT=$((COUNT + 1))
  status=0
  bash "$DIFF" --in "$real" --quiet >/dev/null 2>&1 || status=$?
  case "$status" in
    0) ;;
    1) DIVERGED=$((DIVERGED + 1))
       echo "$entry ($real) has local modifications relative to $(short "$(field "$real/.gitrepo" commit)")"
       bash "$DIFF" --in "$real" --stat 2>/dev/null | sed 's/^/    /' || true ;;
    *) FAILED=$((FAILED + 1))
       echo "$entry ($real): could not compare"
       bash "$DIFF" --in "$real" --quiet 2>&1 >/dev/null | sed 's/^/    /' || true ;;
  esac
done < <(release_dependencies)

if [[ "$DIVERGED" == 0 && "$FAILED" == 0 ]]; then
  lib_say "every release dependency matches its pinned commit ($COUNT checked)"
  exit 0
fi
if [[ "$DIVERGED" -gt 0 ]]; then
  cat <<'WHY'

A release dependency ships as a pointer, so the pointer has to be honest.
Either revert these changes, propose them upstream
(bash <dependency>/.suede/core/upstream), or vendor the dependency so the
source itself ships: `git mv <folder> release/<name>` and remove its
declaring symlink.
WHY
  exit 1
fi
exit 2
