#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_host="${TYPE_SITE_HOST:-i167}"
remote_root="${TYPE_SITE_ROOT:-/srv/type-site}"
release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
upload_root="/tmp/type-site-${release_stamp}"
backup_root="${remote_root}.backup-${release_stamp}"

test -f "${repo_root}/site/index.html"
test -f "${repo_root}/site/metrica.js"

node "${repo_root}/scripts/inject-site-metrica.mjs"
node "${repo_root}/scripts/test-site-metrica.mjs"

ssh "${remote_host}" \
  "test -d '${remote_root}' && sudo cp -a '${remote_root}' '${backup_root}'"

rsync -av --delete --chmod=u=rwX,go=rX \
  "${repo_root}/site/" \
  "${remote_host}:${upload_root}/"

ssh "${remote_host}" \
  "sudo rsync -a --delete --chmod=u=rwX,go=rX '${upload_root}/' '${remote_root}/' \
  && sudo chown -R max:max '${remote_root}'"

echo "Deployed gigatype.app to ${remote_host}:${remote_root}"
echo "Backup: ${remote_host}:${backup_root}"
