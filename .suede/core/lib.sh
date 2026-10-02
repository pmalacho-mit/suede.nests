#!/usr/bin/env bash
# .suede/core/lib.sh — what the maintainer's scripts have in common. Sourced,
# never run.
#
# The one rule everything here applies: a RELEASE DEPENDENCY is a root entry
# named <repo><sep><name> - a symlink, by convention - that resolves to a folder
# holding a .gitrepo outside release/. <repo> is this repository's name and
# <sep> is `.` or `__`. Nothing else declares one.
#
# Inputs (env):
#   RELEASE_DIR          default: release
#   SUEDE_RELEASE_CORE   where the consumer-facing scripts (diff, deps.sh) are;
#                        default: $RELEASE_DIR/.suede/core, which is where a
#                        dependency vendors them

RELEASE_DIR="${RELEASE_DIR:-release}"
SEPARATORS=("." "__")

lib_die() { printf '%s: %s\n' "${LIB_PREFIX:-suede}" "$*" >&2; exit 1; }
lib_say() { printf '%s: %s\n' "${LIB_PREFIX:-suede}" "$*" >&2; }

# Everything runs from the repository root, with root-relative paths.
lib_enter_root() {
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || lib_die "not inside a git repository"
  ROOT="$(cd "$ROOT" && pwd -P)"
  cd "$ROOT"
}

# The repository's name: what origin calls it, else the folder.
repo_name() {
  local url
  if url="$(git remote get-url origin 2>/dev/null)"; then
    url="${url%/}"; url="${url%.git}"; printf '%s\n' "${url##*[:/]}"
  else
    basename "$ROOT"
  fi
}

field() { git config -f "$1" --get "subrepo.$2" 2>/dev/null || true; }
short() { printf '%s' "${1:0:7}"; }

# The published spelling of a remote. A shipped record is resolved by people
# and runners holding no key of ours, so it names HTTPS; the live .gitrepo
# keeps whatever it has (SSH, from the installer) for pushing.
https_spelling() { # <url>
  local url="$1" rest host path
  case "$url" in
    ssh://*) rest="${url#ssh://}"; rest="${rest#*@}"; host="${rest%%/*}"; path="${rest#*/}" ;;
    *@*:*)   rest="${url#*@}"; host="${rest%%:*}"; path="${rest#*:}" ;;
    *)       printf '%s\n' "$url"; return ;;
  esac
  path="${path%/}"; path="${path%.git}"
  printf 'https://%s/%s\n' "$host" "$path"
}

# Root-relative real path of an entry, following a symlink; empty if it does
# not resolve to a directory.
real_path_of() { # <entry>
  local target
  target="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  printf '%s\n' "${target#"$ROOT"/}"
}

# Every release dependency, as "<entry>\t<real path>" lines, sorted. Entries
# that carry the name but do not resolve to an install are reported on stderr
# and left out: an unfinished install or a leftover, not a declaration.
release_dependencies() {
  local repo entry sep real
  repo="$(repo_name)"
  for entry in "$repo".* "$repo"__*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    for sep in "${SEPARATORS[@]}"; do
      [[ "$entry" == "$repo$sep"?* ]] || continue
      real="$(real_path_of "$entry")"
      if [[ -z "$real" ]]; then
        lib_say "$entry: dangling - it declares a release dependency but points at nothing"
      elif [[ ! -f "$real/.gitrepo" ]]; then
        lib_say "$entry: $real has no .gitrepo - not an installed dependency"
      elif [[ "$real" == "$RELEASE_DIR" || "$real" == "$RELEASE_DIR"/* ]]; then
        lib_say "$entry: points inside $RELEASE_DIR/ - a vendored dependency needs no declaration"
      else
        printf '%s\t%s\n' "$entry" "$real"
      fi
      break
    done
  done | sort
}

# The consumer-facing script of that name, from the copy this repository
# vendors into release/. It has to be current: deps.sh is newer than some
# published cores.
release_tool() { # <name>
  local core="${SUEDE_RELEASE_CORE:-$RELEASE_DIR/.suede/core}"
  [[ -f "$core/$1" ]] \
    || lib_die "$core/$1 not found - update the vendored core with: bash .suede/core/sync.sh"
  printf '%s\n' "$core/$1"
}
