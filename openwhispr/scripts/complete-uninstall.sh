#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "This script will stop Type, remove the installed app, and delete caches, databases, and preferences."
read -r -p "Continue with the full uninstall? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target" 2>/dev/null || sudo rm -rf "$target"
  fi
}

echo "Stopping running Type/Electron processes..."
pkill -f "Type" 2>/dev/null || true
pkill -f "open-whispr" 2>/dev/null || true
pkill -f "Electron Helper.*Type" 2>/dev/null || true

echo "Removing /Applications/Type.app (requires admin)..."
remove_target "/Applications/Type.app"

echo "Purging Application Support data..."
remove_target "$HOME/Library/Application Support/Type"
remove_target "$HOME/Library/Application Support/open-whispr"
remove_target "$HOME/Library/Application Support/Type-dev"
remove_target "$HOME/Library/Application Support/com.openwhispr"
remove_target "$HOME/Library/Application Support/com.openwhispr.Type"

echo "Removing caches, logs, and saved state..."
remove_target "$HOME/Library/Caches/open-whispr"
remove_target "$HOME/Library/Caches/com.openwhispr.Type"
remove_target "$HOME/Library/Preferences/com.openwhispr.Type.plist"
remove_target "$HOME/Library/Preferences/com.openwhispr.helper.plist"
remove_target "$HOME/Library/Logs/Type"
remove_target "$HOME/Library/Saved Application State/com.openwhispr.Type.savedState"

echo "Cleaning temporary files..."
shopt -s nullglob
for tmp in /tmp/openwhispr*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/Type_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove legacy Whisper model caches (~/.cache/whisper, ~/Library/Application Support/whisper)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/whisper"
  remove_target "$HOME/Library/Application Support/whisper"
  remove_target "$HOME/Library/Application Support/Type/models"
fi

ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove the local environment file at $ENV_FILE? [y/N]: " wipe_env
  if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
    echo "Removing $ENV_FILE"
    rm -f "$ENV_FILE"
  fi
fi

cat <<'EOF'
macOS keeps microphone, screen recording, and accessibility approvals even after files are removed.
Reset them if you want a truly fresh start:
  tccutil reset Microphone com.openwhispr.app
  tccutil reset Accessibility com.openwhispr.app
  tccutil reset ScreenCapture com.openwhispr.app

Full uninstall complete. Reboot if you removed permissions, then reinstall or run npm scripts on a clean tree.
EOF
