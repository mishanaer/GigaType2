#!/usr/bin/env bash
# Trigger the "Build Windows app (unsigned)" GitHub Actions workflow on demand.
#
# Dispatches the workflow (workflow_dispatch), waits for the new run to appear,
# and prints its URL. With --watch it also follows the run to completion and
# prints the installer download link (the windows-dev-build-wired prerelease).
#
# Usage:
#   scripts/trigger-windows-build.sh [--ref <branch>] [--repo <owner/name>] [--watch]
#
# Examples:
#   scripts/trigger-windows-build.sh                 # dispatch on the default branch below
#   scripts/trigger-windows-build.sh --watch         # dispatch and follow to completion
#   scripts/trigger-windows-build.sh --ref main -w   # dispatch a different branch
#
# The wired-model build (fp32 GigaAM bundled into the app) lives in the
# build-windows-app.yml on main, and workflow_dispatch runs the workflow file
# FROM the target ref — so the default ref must be a branch that has the
# wired-model workflow. The old windows-gigaam-sidecar branch does NOT, which
# is why dispatching on it produced installers without the bundled model.
#
# Defaults (override via flags or env):
#   ref  = main                     (env: WIN_BUILD_REF)
#   repo = mishanaer/GigaType2      (env: WIN_BUILD_REPO)
#
# Requires: the GitHub CLI `gh`, authenticated (`gh auth login`). The build is
# heavy (~15-25 min) and unsigned; the finished installer lands as a Release
# asset, so it works even when the account's Actions artifact quota is full.

set -euo pipefail

REPO="${WIN_BUILD_REPO:-mishanaer/GigaType2}"
REF="${WIN_BUILD_REF:-main}"
WORKFLOW="build-windows-app.yml"
RELEASE_TAG="windows-dev-build-wired"
WATCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)    REF="$2"; shift 2 ;;
    --ref=*)  REF="${1#*=}"; shift ;;
    --repo)   REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --watch|-w) WATCH=1; shift ;;
    -h|--help) awk 'NR>1 && /^set /{exit} NR>1 && /^#/{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "error: unknown argument '$1' (try --help)" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "error: GitHub CLI 'gh' not found — install from https://cli.github.com" >&2
  exit 1
}
gh auth status >/dev/null 2>&1 || {
  echo "error: gh is not authenticated — run 'gh auth login'" >&2
  exit 1
}

# gh workflow run prints nothing useful, so remember the latest dispatch run id
# beforehand and poll until a newer one shows up — that's the run we just made.
prev_id="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$REF" \
  --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"

echo "Dispatching '$WORKFLOW' on $REPO @ $REF ..."
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF"

printf 'Waiting for the run to start'
run_id=""
for _ in $(seq 1 20); do
  sleep 3
  run_id="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$REF" \
    --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  if [ -n "$run_id" ] && [ "$run_id" != "$prev_id" ]; then
    break
  fi
  run_id=""
  printf '.'
done
echo

if [ -z "$run_id" ]; then
  echo "Dispatched, but the new run hasn't appeared yet. Check:" >&2
  echo "  gh run list --repo $REPO --workflow $WORKFLOW --branch $REF" >&2
  exit 0
fi

url="$(gh run view "$run_id" --repo "$REPO" --json url -q .url)"
echo "Build started: $url"

if [ "$WATCH" -eq 1 ]; then
  echo "Watching until it finishes (Ctrl-C stops watching; the build keeps running)..."
  if gh run watch "$run_id" --repo "$REPO" --exit-status --interval 30; then
    echo "Build succeeded."
    echo "Installer: https://github.com/$REPO/releases/tag/$RELEASE_TAG"
  else
    echo "Build failed — logs: $url" >&2
    exit 1
  fi
fi
