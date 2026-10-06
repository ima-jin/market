#!/usr/bin/env bash
#
# sync-from-template.sh — pull upstream changes from ima-jin/imajin-app-template
# into this app as an ordinary incremental git merge.
#
# The template is wired as a git remote named `template`. This works as a plain
# `git merge` only if the app's history and the template's history are JOINED
# (i.e. they share a common ancestor). Apps created with GitHub's "Use this
# template" button start with unrelated history, so they need a ONE-TIME join
# first — this script detects that and prints the exact commands. Apps created
# the way the README describes (clone + rename) are joined from day one.
#
# Usage:
#   scripts/sync-from-template.sh            # fetch + merge template/main onto a sync branch
#   scripts/sync-from-template.sh --check    # fetch + show what would change; no merge, no branch
#   scripts/sync-from-template.sh --help
#
# Environment:
#   TEMPLATE_URL     override the template clone URL (default: ima-jin/imajin-app-template)
#   TEMPLATE_BRANCH  override the template branch to sync from (default: main)
#
# Exit codes:
#   0  synced (or already up to date / --check finished)
#   1  merge conflict, or the working tree is dirty
#   2  histories are not joined yet — run the one-time join (instructions printed)
#
# What you own vs. what flows in:
#   - Shared contract (AGENTS.md §1–§7, config files, CI, README frame) → flows in from the template.
#   - AGENTS.md §8 "This App" → yours; on conflict KEEP your version of that section.
#
set -euo pipefail

TEMPLATE_URL="${TEMPLATE_URL:-https://github.com/ima-jin/imajin-app-template}"
TEMPLATE_REMOTE="template"
TEMPLATE_BRANCH="${TEMPLATE_BRANCH:-main}"
TEMPLATE_REF="$TEMPLATE_REMOTE/$TEMPLATE_BRANCH"
SYNC_BRANCH="chore/sync-from-template"

check_only=false
case "${1:-}" in
  "") ;;
  --check) check_only=true ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "unknown argument: $1 (try --help)" >&2
    exit 64
    ;;
esac

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "✗ not inside a git repository" >&2
  exit 1
fi

# 1. Ensure the template remote exists and is current.
if git remote | grep -qx "$TEMPLATE_REMOTE"; then
  echo "→ remote '$TEMPLATE_REMOTE' already present"
else
  echo "→ adding remote '$TEMPLATE_REMOTE' → $TEMPLATE_URL"
  git remote add "$TEMPLATE_REMOTE" "$TEMPLATE_URL"
fi
echo "→ fetching $TEMPLATE_REF"
git fetch --quiet "$TEMPLATE_REMOTE" "$TEMPLATE_BRANCH"

# 2. Detect whether histories are joined (is there a common ancestor?).
if ! git merge-base HEAD "$TEMPLATE_REF" >/dev/null 2>&1; then
  cat <<MSG

⚠️  histories NOT joined — this repo shares no history with $TEMPLATE_REF.
    (Typical for an app created with GitHub's "Use this template" button.)
    A plain merge now would be an --allow-unrelated-histories merge with add/add
    conflicts on nearly every file. Do the ONE-TIME join below instead; it
    changes NO files, it only records the template history as an ancestor.

    1. Find the template commit this app was generated from (the template's
       state when the app repo was created). Compare trees to confirm, e.g.:
           git log --format='%h %ci %s' $TEMPLATE_REF | less
           git diff --stat <candidate-sha> HEAD     # should show only app changes
       Joining at the *generating* commit — not blindly at $TEMPLATE_BRANCH — is
       what lets every LATER template change flow in via this script. Joining
       at the tip would mark all tip changes as already merged and skip them.

    2. Create the join on a branch and open a PR (history-only, no file changes):
           git checkout -b chore/join-template-history
           git merge -s ours --allow-unrelated-histories <sha> \\
               -m "chore: join template history (one-time)"
           git diff --stat HEAD~1 HEAD              # must print nothing
           git push -u origin chore/join-template-history

    3. After that PR is merged, re-run: scripts/sync-from-template.sh
MSG
  exit 2
fi
echo "→ histories already joined; incremental merge"

# 3. Anything to pull?
if [[ -z "$(git rev-list --max-count=1 "HEAD..$TEMPLATE_REF")" ]]; then
  echo "✓ already up to date with $TEMPLATE_REF"
  exit 0
fi

echo "→ template commits not yet in HEAD:"
git --no-pager log --oneline "HEAD..$TEMPLATE_REF"

if $check_only; then
  echo "→ files that would be touched:"
  git --no-pager diff --stat "HEAD...$TEMPLATE_REF"
  exit 0
fi

# 4. Merge onto a dedicated branch so it always lands via PR (never straight to main).
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ working tree has uncommitted changes — commit or stash them first" >&2
  exit 1
fi

current="$(git branch --show-current)"
if [[ "$current" == "$SYNC_BRANCH" ]]; then
  echo "→ already on $SYNC_BRANCH"
elif git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  echo "→ switching to existing $SYNC_BRANCH"
  git checkout "$SYNC_BRANCH"
else
  echo "→ creating $SYNC_BRANCH from ${current:-HEAD}"
  git checkout -b "$SYNC_BRANCH"
fi

set +e
git merge --no-edit "$TEMPLATE_REF"
merge_status=$?
set -e

if [[ $merge_status -ne 0 ]]; then
  cat <<'MSG'

⚠️  Merge conflict(s). Almost always AGENTS.md §8 (This App) — that section is YOURS.
    Open AGENTS.md, keep your app-specific §8, accept incoming §1–§7, then:
        git add -A && git commit --no-edit
    For non-AGENTS files, prefer the template (git checkout --theirs <file>)
    unless you intentionally diverged. To bail out: git merge --abort
MSG
  exit 1
fi

echo
echo "✓ merged $TEMPLATE_REF onto $SYNC_BRANCH"
echo "  Next: push and open a PR, e.g."
echo "    git push -u origin $SYNC_BRANCH"
echo "    gh pr create --fill"
