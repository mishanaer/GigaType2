#!/usr/bin/env bash
# Деплой stats-модуля GigaType на stats-хост Traction (по образцу
# traction/modules/multitool/deploy.sh из репо GigaTool).
#
# Usage:
#   REMOTE=max@158.160.163.167 ./deploy.sh
#   DRY_RUN=1 REMOTE=... ./deploy.sh
#
# На хосте: passwordless sudo; юнит stats-gigatype уже установлен
# (первичная установка — traction/ONBOARDING.md §3).
set -euo pipefail

# Без дефолтного хоста намеренно: случайный запуск не должен улететь не туда.
REMOTE="${REMOTE:?set REMOTE=user@host (canonical: the stats box i167, e.g. max@158.160.163.167)}"
REMOTE_DIR="${REMOTE_DIR:-/srv/stats/gigatype/app}"
DRY_RUN="${DRY_RUN:-0}"

HERE="$(cd "$(dirname "$0")" && pwd)"

# VERSION штампуется деплоем и отдаётся в /health (анти-дрейф, spec §6.1).
# Пишем во временный файл, не в рабочее дерево — деплой не грязнит репо.
VERSION="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo unknown)-$(date -u +%Y%m%d%H%M)"

FLAGS=(-az --exclude=.venv --exclude=__pycache__ --exclude='*.pyc'
  --exclude=data --exclude=deploy.sh --exclude=.DS_Store)
[ "$DRY_RUN" = "1" ] && FLAGS+=(--dry-run -v)

echo "[deploy] $HERE -> $REMOTE:$REMOTE_DIR (v$VERSION)"
rsync "${FLAGS[@]}" --rsync-path="sudo rsync" "$HERE/" "$REMOTE:$REMOTE_DIR/"

if [ "$DRY_RUN" = "1" ]; then
  echo "[deploy] dry-run done; remote untouched"
  exit 0
fi

TMP_VERSION="$(mktemp)"
printf '%s\n' "$VERSION" > "$TMP_VERSION"
rsync -az --rsync-path="sudo rsync" "$TMP_VERSION" "$REMOTE:$REMOTE_DIR/VERSION"
rm -f "$TMP_VERSION"

# Версии пришпилены: свежий мажор fastapi/starlette не должен превращать
# рутинный деплой в даун (health-чек его поймает, но отката нет).
ssh "$REMOTE" "cd '$REMOTE_DIR' \
  && { [ -x .venv/bin/python ] || sudo python3 -m venv .venv; } \
  && sudo .venv/bin/pip install -q 'fastapi==0.128.*' 'uvicorn==0.39.*' \
  && sudo chown -R gigatool:gigatool /srv/stats/gigatype \
  && sudo systemctl restart stats-gigatype && sleep 2 \
  && systemctl is-active stats-gigatype \
  && curl -sf http://127.0.0.1:9902/health \
  && curl -sf 'http://127.0.0.1:9902/summary?days=1' >/dev/null \
  && echo '[remote] health + summary OK'"
echo "[deploy] done"
