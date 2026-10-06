#!/usr/bin/env bash
#
# init-taxonomy.sh — seed a GitHub repo's issue labels from the canonical
# ima-jin/conventions taxonomy.json. Idempotent: creates missing labels,
# updates colour/description on existing ones, never duplicates.
#
# Usage:
#   scripts/init-taxonomy.sh <owner/repo>                 # seed the universal set (default)
#   scripts/init-taxonomy.sh <owner/repo> --set platform  # seed a named set
#   scripts/init-taxonomy.sh <owner/repo> --set universal --set platform  # multiple sets
#   scripts/init-taxonomy.sh <owner/repo> --dry-run       # show what would change
#
# Requires: gh (authenticated), jq. Reads taxonomy.json from the repo root
# (one dir up from this script) unless TAXONOMY_JSON is set.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAXONOMY_JSON="${TAXONOMY_JSON:-$here/../taxonomy.json}"

repo=""
sets=()
dry_run=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --set)     sets+=("$2"); shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -*)        echo "unknown flag: $1" >&2; exit 2 ;;
    *)         repo="$1"; shift ;;
  esac
done

if [[ -z "$repo" ]]; then
  echo "usage: init-taxonomy.sh <owner/repo> [--set NAME]... [--dry-run]" >&2
  exit 2
fi
[[ ${#sets[@]} -eq 0 ]] && sets=("universal")
[[ -f "$TAXONOMY_JSON" ]] || { echo "taxonomy.json not found at $TAXONOMY_JSON" >&2; exit 1; }

echo "→ repo:  $repo"
echo "→ sets:  ${sets[*]}"
$dry_run && echo "→ DRY RUN (no changes)"

for set in "${sets[@]}"; do
  count="$(jq -r --arg s "$set" '.sets[$s].labels | length // 0' "$TAXONOMY_JSON")"
  if [[ "$count" == "0" || "$count" == "null" ]]; then
    echo "  ⚠ set '$set' not found or empty — skipping" >&2
    continue
  fi
  echo "── set: $set ($count labels) ──"
  # Stream each label as a compact JSON object.
  while IFS= read -r label; do
    name="$(jq -r '.name' <<<"$label")"
    color="$(jq -r '.color' <<<"$label")"
    desc="$(jq -r '.description' <<<"$label")"
    if $dry_run; then
      echo "  would ensure: $name (#$color) — $desc"
      continue
    fi
    # gh label create --force upserts (create or update colour+description).
    if gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force >/dev/null 2>&1; then
      echo "  ✓ $name"
    else
      echo "  ✗ $name (failed — check gh auth / repo access)" >&2
    fi
  done < <(jq -c --arg s "$set" '.sets[$s].labels[]' "$TAXONOMY_JSON")
done

echo "✓ done"
