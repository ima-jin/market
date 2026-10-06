#!/usr/bin/env bash
# One-command deploy of the standalone ima-jin/market app (refs imajin-ai#2511).
#
#   scripts/deploy.sh <prod|dev> [--ref <git-ref>] [--dry-run]
#
# Run it from the target's own checkout (~/prod/market or ~/dev/market) on the
# server. Steps, in order — any failure stops the deploy before pm2 is touched
# (the running process keeps serving until step 8):
#
#   1. preflight   tools present, Node version, clean tree, env file exists,
#                  no pm2 entry of the same name pointing at another path
#   2. checkout    fetch + check out the ref (default: origin/main), detached
#   3. env check   scripts/check-env.mjs validates the env file for the target
#                  (runs AFTER checkout so it uses the code being deployed)
#   4. install     pnpm install --frozen-lockfile
#   5. build       next build, env file loaded (NEXT_PUBLIC_* is baked in here)
#   6. baseline    scripts/migrate-baseline.mjs (idempotent; refuses on mismatch)
#      migrate     drizzle-kit migrate (forward-only; only what the baseline
#                  did not already cover)
#   7. restart     pm2 startOrReload ecosystem.config.cjs --only <prod|dev>-market
#   8. health      GET <base path>/api/health must report status "ok"
#
# Rollback = redeploy a previous tag/sha: scripts/deploy.sh prod --ref <tag>.
# Migrations are forward-only. See docs/DEPLOY.md.
#
# Everything lives inside main(), invoked on the last line: step 2 swaps this
# very file for the new ref's copy, and bash must not be mid-read of it.
set -euo pipefail

readonly BASE_PATH="/market"
readonly HEALTH_ATTEMPTS=30
readonly HEALTH_INTERVAL_SECONDS=2
readonly TOTAL_STEPS=8

dry_run=false

usage() {
  echo "Usage: scripts/deploy.sh <prod|dev> [--ref <git-ref>] [--dry-run]" >&2
}

fail() {
  echo "deploy: $*" >&2
  exit 1
}

step() {
  echo
  echo "==> [$1/${TOTAL_STEPS}] $2"
}

# Runs a command, or only prints it under --dry-run.
run() {
  echo "+ $*"
  if [[ "${dry_run}" == "false" ]]; then
    "$@"
  fi
}

preflight() {
  local env_file="$1" app_name="$2" repo_root="$3"
  local tool want_node_major have_node_major existing_cwd
  for tool in git node pnpm pm2 curl; do
    command -v "${tool}" >/dev/null 2>&1 || fail "required tool not found on PATH: ${tool}"
  done
  want_node_major="$(tr -d 'v\n' < .nvmrc | cut -d. -f1)"
  have_node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${have_node_major}" -ge "${want_node_major}" ]] \
    || fail "Node ${want_node_major}+ required (found ${have_node_major}) — see .nvmrc"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] \
    || fail "working tree has local changes to tracked files — refusing to deploy over them"
  [[ -f "${env_file}" ]] || fail "missing ${env_file} — see docs/ENVIRONMENTS.md"
  # A pm2 entry of the same name that points somewhere else (e.g. the pruned
  # monorepo apps/market path) would be "reloaded" with its OLD script/cwd, not
  # this checkout's. Removing it is a one-time operator step, never automatic.
  existing_cwd="$(pm2_existing_cwd "${app_name}")"
  if [[ -n "${existing_cwd}" && "${existing_cwd}" != "${repo_root}" ]]; then
    fail "pm2 already runs ${app_name} from ${existing_cwd}, not ${repo_root}. One-time cutover step: pm2 delete ${app_name} && pm2 save, then re-run (docs/DEPLOY.md)."
  fi
}

# Prints the cwd of an existing pm2 process with this name ("" if none).
pm2_existing_cwd() {
  local app_name="$1"
  pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const list = JSON.parse(raw.slice(raw.indexOf("[")));
        const found = list.find((proc) => proc.name === process.argv[1]);
        process.stdout.write(found ? found.pm2_env.pm_cwd : "");
      } catch {
        process.stdout.write("");
      }
    });
  ' "${app_name}"
}

# `node --env-file` and `pm2 --update-env` both let the CALLER's shell env win
# over the env file — a stray DATABASE_URL exported in the deployer's shell
# would silently point the build, the migrations AND the pm2 process at the
# wrong database. Drop every variable the contract knows about so the env file
# is the single source of truth. Prints names only, never values.
scrub_inherited_env() {
  local name scrubbed=()
  while IFS= read -r name; do
    if [[ -n "${!name+x}" ]]; then
      scrubbed+=("${name}")
      unset "${name}"
    fi
  done < <(node --input-type=module -e "
    import { ENV_VAR_NAMES } from './scripts/lib/env-manifest.mjs';
    console.log(ENV_VAR_NAMES.join('\\n'));
  ")
  if [[ ${#scrubbed[@]} -gt 0 ]]; then
    echo "Ignoring variables inherited from the calling shell (the env file wins): ${scrubbed[*]}"
  fi
}

health_check() {
  local app_name="$1" health_url="$2" attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if curl -fsS --max-time 5 "${health_url}" 2>/dev/null | grep -q '"status":"ok"'; then
      echo "healthy: ${app_name} answered ${health_url} (attempt ${attempt})"
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  echo "deploy: ${app_name} did not report healthy at ${health_url} after $((HEALTH_ATTEMPTS * HEALTH_INTERVAL_SECONDS))s." >&2
  echo "deploy: inspect with: pm2 logs ${app_name} --lines 100" >&2
  echo "deploy: a first boot needs IMAJIN_APP_CLAIM_CODE in the env file (docs/DEPLOY.md, 'First boot')." >&2
  return 1
}

main() {
  local target="${1:-}" app_name port
  case "${target}" in
    prod)
      app_name="prod-market"
      port=7104
      ;;
    dev)
      app_name="dev-market"
      port=3104
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  shift

  local ref=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        ref="$2"
        shift 2
        ;;
      --dry-run)
        dry_run=true
        shift
        ;;
      *)
        usage
        exit 2
        ;;
    esac
  done

  local repo_root env_file checkout_ref health_url
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  env_file="${repo_root}/.env.local"
  checkout_ref="${ref:-origin/main}"
  health_url="http://127.0.0.1:${port}${BASE_PATH}/api/health"

  echo "Deploying market -> ${target} (${app_name}, port ${port}) from ${repo_root}"
  echo "Ref: ${checkout_ref}"
  if [[ "${dry_run}" == "true" ]]; then
    echo "DRY RUN — printing the plan only; nothing is executed."
  fi

  cd "${repo_root}"
  scrub_inherited_env

  step 1 "preflight"
  if [[ "${dry_run}" == "false" ]]; then
    preflight "${env_file}" "${app_name}" "${repo_root}"
  else
    echo "+ (check tools, Node version, clean tree, ${env_file}, no stale pm2 ${app_name})"
  fi

  step 2 "checkout ${checkout_ref}"
  run git fetch --tags --prune origin
  run git checkout --detach "${checkout_ref}"

  step 3 "env check (${target})"
  run node scripts/check-env.mjs "${target}" --file "${env_file}"

  step 4 "install"
  run pnpm install --frozen-lockfile

  step 5 "build (env file loaded: NEXT_PUBLIC_* values are baked in here)"
  run node "--env-file=${env_file}" node_modules/next/dist/bin/next build

  step 6 "migration baseline (idempotent; refuses on schema mismatch), then migrate (forward-only)"
  run node "--env-file=${env_file}" scripts/migrate-baseline.mjs
  run node "--env-file=${env_file}" node_modules/drizzle-kit/bin.cjs migrate

  step 7 "restart ${app_name}"
  run pm2 startOrReload ecosystem.config.cjs --only "${app_name}" --update-env
  run pm2 save

  step 8 "health check"
  if [[ "${dry_run}" == "true" ]]; then
    echo "+ poll ${health_url} until it reports status ok (${HEALTH_ATTEMPTS} x ${HEALTH_INTERVAL_SECONDS}s)"
    echo
    echo "Dry run complete."
    return 0
  fi
  health_check "${app_name}" "${health_url}"

  echo
  echo "Deploy complete: $(git rev-parse --short HEAD) -> ${app_name}"
}

main "$@"
exit $?
