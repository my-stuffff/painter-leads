#!/bin/sh
# Railway worker: migrate, then either
#  - PP_MODE=worker: the web app's job worker (`pp worker`), which runs until Railway stops it (SIGTERM -> exit 0);
#  - otherwise: run each `pp` command in PP_JOB (separated by ';') in order, logging to stdout. The container then
#    idles, so the logs stay readable and nothing re-runs on its own (restart policy NEVER).
set -u
mkdir -p "$PP_DATA_DIR"
pnpm --silent pp db migrate --create
if [ "${PP_MODE:-}" = "worker" ]; then
  exec pnpm --silent pp worker --id "${RAILWAY_SERVICE_NAME:-$(hostname)}"
fi
echo "{\"type\":\"job-start\",\"job\":\"${PP_JOB:-}\"}"
code=0
OLDIFS=$IFS; IFS=';'
for cmd in ${PP_JOB:-}; do
  IFS=$OLDIFS
  echo "{\"type\":\"cmd-start\",\"cmd\":\"$cmd\"}"
  # shellcheck disable=SC2086
  pnpm --silent pp $cmd
  code=$?
  echo "{\"type\":\"cmd-exit\",\"cmd\":\"$cmd\",\"code\":$code}"
  IFS=';'
done
IFS=$OLDIFS
echo "{\"type\":\"job-exit\",\"code\":$code}"
exec sleep infinity
