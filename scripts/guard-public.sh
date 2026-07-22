#!/usr/bin/env sh
set -eu

list="private/forbidden-tokens.txt"
[ -f "$list" ] || exit 0

matches=$(git grep -I -i -n -f "$list" -- ':!bun.lock' || true)
if [ -n "$matches" ]; then
  echo "guard-public: forbidden tokens found in tracked files:" >&2
  echo "$matches" >&2
  exit 1
fi
