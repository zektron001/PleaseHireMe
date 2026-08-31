#!/usr/bin/env bash
# Runs the control plane on the HOST, with .env for credentials but host paths
# for state.
#
# Two things this has to get right.
#
#   .env is PARSED, not sourced. Node's --env-file reads the file without
#   executing it. Sourcing it in a shell runs any line whose value has unquoted
#   spaces - `FOO=a b c` executes `b c` - which is a real trip hazard in a file
#   people hand-edit.
#
#   .env is also the file docker-compose reads, so APP_DATA_DIR,
#   AGENT_WORKSPACE_ROOT and CODEX_HOME in it are CONTAINER paths (/app/...).
#   On the host those make the server try to mkdir /app and die with EACCES, so
#   host paths are exported first. Node's --env-file does NOT override a
#   variable that is already set, which is exactly the precedence needed - and
#   it also means `APP_DATA_DIR=/tmp/x npm run dev` still wins.
set -euo pipefail

mode="${1:-dev}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

# Host state, under the repo root where .gitignore already excludes it.
export APP_DATA_DIR="${APP_DATA_DIR:-$repo/.data}"
export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$repo/workspaces}"
export CODEX_HOME="${CODEX_HOME:-$repo/codex-home}"
export AEGIS_VAULT_PATH="${AEGIS_VAULT_PATH:-$repo/.vault}"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"

# Expanded below as ${env_flag[@]+"${env_flag[@]}"} rather than "${env_flag[@]}".
# macOS ships bash 3.2, where expanding an EMPTY array under `set -u` is an
# "unbound variable" error; bash 4.4 fixed it. So the plain form works on Linux
# and kills the server on any Mac whose checkout has no credentials file.
env_flag=()
if [[ -f "$repo/.env" ]]; then
  env_flag=(--env-file-if-exists="$repo/.env")
fi

cd "$repo/apps/server"
if [[ "$mode" == "start" ]]; then
  exec node ${env_flag[@]+"${env_flag[@]}"} dist/index.js
fi
exec npx tsx watch ${env_flag[@]+"${env_flag[@]}"} src/index.ts
