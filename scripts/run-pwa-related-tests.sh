#!/usr/bin/env bash
set -euo pipefail

base="${FLOW_QUALITY_BASE:-}"
if [[ -z "$base" ]]; then
  if git rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
    upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
    base="$(git merge-base HEAD "$upstream")"
  elif git rev-parse --verify origin/master >/dev/null 2>&1; then
    base="$(git merge-base HEAD origin/master)"
  else
    base="$(git rev-parse HEAD~1)"
  fi
fi

collect_files() {
  {
    git diff --name-only --diff-filter=ACMRTUXB -- src tests
    git ls-files --others --exclude-standard -- src tests
  } | awk '!seen[$0]++' | grep -E '\.(js|jsx|ts|tsx)$' || true
}

changed_files=()
while IFS= read -r file; do
  changed_files+=("$file")
done < <(collect_files)

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  while IFS= read -r file; do
    changed_files+=("$file")
  done < <(
    git diff --name-only --diff-filter=ACMRTUXB "$base"...HEAD -- src tests \
      | awk '!seen[$0]++' \
      | grep -E '\.(js|jsx|ts|tsx)$' || true
  )
fi

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  echo "No changed JS/TS files under src/ or tests/; skipping related Vitest run."
  exit 0
fi

echo "Running Vitest related tests for ${#changed_files[@]} changed file(s)."
pnpm vitest related --run "${changed_files[@]}"
