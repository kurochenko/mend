#!/usr/bin/env bash
set -eu
set -o pipefail

if [ "$#" -eq 0 ]; then
  exit 0
fi

code_files=()

for file in "$@"; do
  [ -f "$file" ] || continue

  case "$file" in
    .beads/*|.codex/*|.opencode/*|.skillbook/*|drizzle/*|fixtures/*|sessions/*|workspaces/*)
      continue
      ;;
    *.ts|*.js|*.mjs|*.cjs)
      code_files+=("$file")
      ;;
    *.json|*.md|*.yml|*.yaml)
      bunx biome format --write "$file"
      ;;
  esac
done

if [ "${#code_files[@]}" -eq 0 ]; then
  exit 0
fi

bunx biome format --write "${code_files[@]}"
bunx eslint "${code_files[@]}"
bunx oxlint "${code_files[@]}"
