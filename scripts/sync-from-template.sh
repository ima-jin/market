#!/usr/bin/env bash
#
# sync-from-template.sh — pull upstream changes from ima-jin/imajin-app-template
# into this app, keeping the app's own history and its app-specific AGENTS.md §6.
#
# The template is wired as a git remote named `template`. The first run joins the
# two histories (--allow-unrelated-histories); every run after is a normal merge.
#
# Usage:
#   scripts/sync-from-template.sh            # fetch + merge template/main onto a branch
#   scripts/sync-from-template.sh --check    # just show what would change, no merge
#
# What you own vs. what flows in:
#   - Shared contract (AGENTS.md §1–§5, config files, README frame) → flows in from template.
#   - AGENTS.md §6 "This App" → yours; resolve any conflict by KEEPING your version.
#
set -euo pipefail

TEMPLATE_URL="https://github.com/ima-jin/imajin-app-template"
TEMPLATE_REMOTE="template"
TEMPLATE_BRANCH="main"
SYNC_BRANCH="chore/sync-from-template"

check_only=false
[[ "${1:-}" == "--check" ]] && check_only=true

# 1. Ensure the template remote exists and is current.
if ! git remote | grep -qx "$TEMPLATE_REMOTE"; then
  echo "→ adding remote '$TEMPLATE_REMOTE' → $TEMPLATE_URL"
  git remote add "$TEMPLATE_REMOTE" "$TEMPLATE_URL"
fi
git fetch --quiet "$TEMPLATE_REMOTE"

# 2. Detect whether histories have been joined yet (is there a common ancestor?).
if git merge-base HEAD "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" >/dev/null 2>&1; then
  merge_flags=""
  echo "→ histories already joined; incremental merge"
else
  merge_flags="--allow-unrelated-histories"
  echo "→ first sync: joining unrelated histories (one-time)"
fi

if $check_only; then
  echo "→ changes on $TEMPLATE_REMOTE/$TEMPLATE_BRANCH not yet in HEAD:"
  git log --oneline "HEAD..$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" || true
  echo "→ files that would be touched:"
  git diff --stat "HEAD...$TEMPLATE_REMOTE/$TEMPLATE_BRANCH" || true
  exit 0
fi

# 3. Merge onto a dedicated branch so it always lands via PR (never straight to main).
current="$(git branch --show-current)"
echo "→ creating $SYNC_BRANCH from $current"
git checkout -B "$SYNC_BRANCH"

set +e
git merge $merge_flags --no-edit "$TEMPLATE_REMOTE/$TEMPLATE_BRANCH"
merge_status=$?
set -e

if [[ $merge_status -ne 0 ]]; then
  cat <<'MSG'

⚠️  Merge conflict(s). Almost always AGENTS.md §6 (This App) — that section is YOURS.
    Resolve by keeping your app-specific §6 and taking template changes for §1–§5:
        git checkout --ours AGENTS.md        # keep your §6 (then re-apply any §1–§5 updates by hand)
    or open AGENTS.md, keep your §6, accept incoming §1–§5, then:
        git add -A && git commit --no-edit

    For non-AGENTS files, prefer the template (--theirs) unless you intentionally diverged.
MSG
  exit 1
fi

echo
echo "✓ merged template/$TEMPLATE_BRANCH onto $SYNC_BRANCH"
echo "  Next: push and open a PR, e.g."
echo "    git push -u origin $SYNC_BRANCH"
echo "    gh pr create --fill"
