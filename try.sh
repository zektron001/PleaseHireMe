#!/usr/bin/env sh
# One line to go from a fresh clone to a running Launchpad:
#
#     ./try.sh
#
# Deliberately POSIX sh, not bash: macOS ships bash 3.2, and there is nothing
# here that needs more than sh. No GNU-only flags, no `sed -i` (which takes a
# mandatory argument on BSD and none on GNU), no arrays.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Get Docker Desktop (macOS) or Docker Engine (Linux)."
fi
if ! docker compose version >/dev/null 2>&1; then
  die "This needs Docker Compose v2 (\`docker compose\`, not \`docker-compose\`)."
fi
if ! docker info >/dev/null 2>&1; then
  die "The Docker daemon is not running. Start Docker and try again."
fi

# ------------------------------------------------------------------------- env
# A token is generated once and kept, so restarts do not invalidate open tabs.
if [ ! -f .env ]; then
  say "→ no .env yet, creating one from .env.example"
  cp .env.example .env

  token=$(
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 16
    else
      LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | dd bs=1 count=32 2>/dev/null
    fi
  )
  # Rewrite without sed -i, which is not portable between GNU and BSD.
  awk -v tok="$token" '
    /^APP_AUTH_TOKEN=/ { print "APP_AUTH_TOKEN=" tok; next }
    { print }
  ' .env > .env.tmp && mv .env.tmp .env
  say "→ generated APP_AUTH_TOKEN"
fi

# The try-it build fills the token in for whoever opens the page.
if grep -q '^DEMO_TRY_MODE=' .env 2>/dev/null; then
  awk '/^DEMO_TRY_MODE=/ { print "DEMO_TRY_MODE=true"; next } { print }' .env > .env.tmp \
    && mv .env.tmp .env
else
  printf '\n# Fills the access token in for the visitor. Local demo only.\nDEMO_TRY_MODE=true\n' >> .env
fi

# AEGIS containment derives fs.read/net.connect from scanning shell TEXT, and
# shell text cannot be parsed reliably (HANDOFF 5a-bis, R17). In this image it
# fires on turns that are doing nothing wrong - four out of four here - and the
# Agent's circuit breaker latches, so a visitor never sees a turn finish. The
# judged track is B (WARRANT), which is untouched by this: warrants, the 403 on
# someone else's Agent, approvals and the merge gate all still hold.
#
# Turn it back on with:  AEGIS_ENABLED=true docker compose up -d
if grep -q '^AEGIS_ENABLED=' .env 2>/dev/null; then
  awk '/^AEGIS_ENABLED=/ { print "AEGIS_ENABLED=false"; next } { print }' .env > .env.tmp \
    && mv .env.tmp .env
else
  printf '\nAEGIS_ENABLED=false\n' >> .env
fi

# The egress broker only resolves on the container network. Running Codex as a
# local process against it is what hangs every turn for ten minutes, so the
# compose path keeps the container runtime and leaves this alone.
ark=$(awk -F= '/^ARK_API_KEY=/ { print $2 }' .env | tr -d ' \r')
if [ -z "${ark:-}" ]; then
  say ""
  say "  ⚠  ARK_API_KEY is empty in .env."
  say "     The workbench will start and you can click through the whole flow,"
  say "     but Agents cannot actually run a turn until you put a key in."
  say ""
fi

mkdir -p data workspaces codex-home

# ----------------------------------------------------------------------- start
say "→ building and starting (first run pulls the base image, so give it a minute)"
docker compose up --build -d

say "→ waiting for the control plane"
i=0
until curl -fsS http://127.0.0.1:"${PUBLIC_PORT:-3000}"/api/health >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    say ""
    say "It did not come up. The logs:"
    docker compose logs --tail 40
    die "startup timed out"
  fi
  sleep 1
done

port="${PUBLIC_PORT:-3000}"
say ""
say "  ┌──────────────────────────────────────────────────────────┐"
say "  │  Agent Launchpad is up                                   │"
say "  ├──────────────────────────────────────────────────────────┤"
say "  │  Open  http://localhost:$port                              "
say "  │                                                          │"
say "  │  The access token is filled in - just press Open.        │"
say "  │  AEGIS containment is off for this build (see try.sh).    │"
say "  │  Then follow the Next card in the bottom right.          │"
say "  └──────────────────────────────────────────────────────────┘"
say ""
say "  stop it with:  docker compose down"
say ""
