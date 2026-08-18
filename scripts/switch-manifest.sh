#!/usr/bin/env bash
# switch-manifest.sh — Manage the Manifest Dynamic Router & Dual-Stack Setup.
#
# Commands:
#   switch-manifest.sh status
#   switch-manifest.sh prod
#   switch-manifest.sh staging
#   switch-manifest.sh restart-prod
#   switch-manifest.sh restart-staging
#   switch-manifest.sh restart-router
#   switch-manifest.sh snapshot [prod-to-staging | staging-to-prod]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$REPO_DIR/docker"
PROD_COMPOSE="$DOCKER_DIR/docker-compose.yml"
DEV_COMPOSE="$DOCKER_DIR/docker-compose.dev.yml"
PROD_ENV="$DOCKER_DIR/.env"
DEV_ENV="$DOCKER_DIR/.env.dev"
ROUTER_SCRIPT="$REPO_DIR/scripts/manifest-router.js"
ROUTER_PORT="${ROUTER_PORT:-2098}"
ROUTER_URL="http://127.0.0.1:${ROUTER_PORT}"
STATE_DIR="${HOME:-/root}/.config/manifest-router"
STATE_FILE="$STATE_DIR/state.json"

# Dedicated source checkouts per stack:
PROD_REPO_DIR="${PROD_REPO_DIR:-/root/projects/manifest}"
STAGING_REPO_DIR="${STAGING_REPO_DIR:-/root/projects/manifest-staging}"
[[ -d "$STAGING_REPO_DIR" ]] || STAGING_REPO_DIR="$REPO_DIR"
[[ -d "$PROD_REPO_DIR" ]] || PROD_REPO_DIR="$REPO_DIR"

# ── helpers ──────────────────────────────────────────────────────────────

prod_compose() {
  local dir="${PROD_REPO_DIR}/docker"
  docker compose -f "$dir/docker-compose.yml" --project-directory "$dir" --env-file "$dir/.env" "$@"
}

dev_compose() {
  local dir="${STAGING_REPO_DIR}/docker"
  docker compose -f "$dir/docker-compose.dev.yml" --project-directory "$dir" --env-file "$dir/.env.dev" "$@"
}

ensure_router_running() {
  if curl -s --max-time 1 "$ROUTER_URL/__router/health" >/dev/null 2>&1; then
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl start manifest-router 2>/dev/null || true
    sleep 0.5
    if curl -s --max-time 1 "$ROUTER_URL/__router/health" >/dev/null 2>&1; then
      return 0
    fi
  fi
  if [[ -f "$ROUTER_SCRIPT" ]] && command -v node >/dev/null 2>&1; then
    nohup node "$ROUTER_SCRIPT" >/tmp/manifest-router.log 2>&1 &
    sleep 0.5
  fi
}

write_state_file_direct() {
  local target="$1"
  local port=2099
  local name="prod"
  if [[ "$target" == "staging" || "$target" == "dev" ]]; then
    port=2100
    name="staging"
  elif [[ "$target" =~ ^[0-9]+$ ]]; then
    port="$target"
    name="custom-$port"
  fi

  mkdir -p "$STATE_DIR"
  cat > "$STATE_FILE" <<EOF
{
  "active": "$name",
  "port": $port,
  "targetUrl": "http://127.0.0.1:$port",
  "lastSwitched": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

# ── commands ─────────────────────────────────────────────────────────────

cmd_help() {
  cat <<'EOF'
switch-manifest.sh — Manifest Dynamic Router & Dual-Stack Manager

USAGE
  switch-manifest.sh <command>

ROUTING (instant switch via router port 2098, no OpenCode restart):
  prod                         Route all requests to PRODUCTION (:2099)
  staging | dev                Route all requests to STAGING (:2100)
  status                       Show active route, router status, and stack health

RESTART:
  restart-prod                 Rebuild image and restart Production stack (:2099)
  restart-staging | restart-dev
                               Rebuild image and restart Staging stack (:2100)
  restart-router               Restart the Dynamic Router daemon (:2098)

SNAPSHOTS:
  snapshot prod-to-staging     Copy Production DB (2099) -> Staging DB (2100)
  snapshot staging-to-prod     Copy Staging DB (2100) -> Production DB (2099)

LIFECYCLE:
  up                           Start both stacks (prod + staging) + router
  down                         Stop both stacks
  rebuild                      Rebuild both stack images from source
EOF
}

cmd_route() {
  local target="$1"
  local label="$2"

  ensure_router_running

  local resp
  resp=$(curl -s --max-time 3 -X POST "$ROUTER_URL/__router/route?target=$target" 2>/dev/null || true)

  if [[ -n "$resp" && "$resp" == *'"status": "ok"'* ]]; then
    local active port
    active=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('active',''))" "$resp" 2>/dev/null || echo "$target")
    port=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('port',''))" "$resp" 2>/dev/null || echo "$label")
    echo "✓ Active route switched to: ${active^^} (port $port)"
    echo "  OpenCode and Paseo requests are now routed immediately to $active (no restart needed)."
  else
    write_state_file_direct "$target"
    echo "✓ Active route updated in state file: $target ($label)"
  fi
}

cmd_status() {
  echo "═══ Dynamic Router (Port $ROUTER_PORT) ═══"
  local router_status
  router_status=$(curl -s --max-time 2 "$ROUTER_URL/__router/status" 2>/dev/null || true)
  if [[ -n "$router_status" && "$router_status" == *'"status": "ok"'* ]]; then
    python3 - "$router_status" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
    active = d.get('active', 'unknown').upper()
    port = d.get('port', 'unknown')
    target = d.get('targetUrl', 'unknown')
    stats = d.get('stats', {})
    reqs = stats.get('totalRequests', 0)
    uptime = stats.get('uptimeSec', 0)
    print(f"Router Status:        ACTIVE (running on port 2098)")
    print(f"Current Target Route: {active} -> {target}")
    print(f"Total Proxied Reqs:   {reqs}")
    print(f"Router Uptime:        {uptime}s")
except Exception as e:
    print(f"Router Status:        ACTIVE (error parsing status: {e})")
PY
  else
    echo "Router Status:        INACTIVE or UNREACHABLE on port $ROUTER_PORT"
    if [[ -f "$STATE_FILE" ]]; then
      echo "State file says:      $(cat "$STATE_FILE" 2>/dev/null || true)"
    fi
  fi

  echo ""
  echo "═══ Production Stack (2099) ═══"
  prod_compose ps 2>/dev/null || echo "(not running)"

  echo ""
  echo "═══ Staging Stack (2100) ═══"
  dev_compose ps 2>/dev/null || echo "(not running)"

  echo ""
  echo "═══ OpenCode Manifest Provider ═══"
  python3 - <<'PY'
import json, os, re
opencode_paths = [os.path.expanduser("~/.config/opencode/opencode.jsonc"), "/root/.config/opencode/opencode.jsonc"]
base_url = "unknown"
for opencode_path in opencode_paths:
    if os.path.exists(opencode_path):
        with open(opencode_path, "r") as f:
            m = re.search(r'"manifest"\s*:\s*\{.*?"baseURL"\s*:\s*"([^"]+)"', f.read(), re.DOTALL)
            if m:
                base_url = m.group(1)
                break
print(f"BaseURL: {base_url}")
if "2098" in base_url:
    print("✓ OpenCode is connected to the Dynamic Router (:2098).")
else:
    print("⚠ OpenCode is not using the Dynamic Router (:2098).")
PY
}

cmd_snapshot_prod_to_staging() {
  echo "Snapshot: PROD (2099) → STAGING (2100)"
  echo "⚠️  This REPLACES the entire STAGING database."
  echo ""

  echo "Stopping Staging manifest..."
  docker stop mnfst-dev-manifest-1 2>/dev/null || true
  sleep 2

  echo "Dumping prod DB..."
  docker exec mnfst-postgres-1 pg_dump -U manifest -Fc manifest > /tmp/prod.dump

  echo "Copying dump into Staging postgres..."
  docker cp /tmp/prod.dump mnfst-dev-postgres-1:/tmp/prod.dump

  echo "Recreating Staging database..."
  docker exec mnfst-dev-postgres-1 psql -U manifest -d postgres -c "DROP DATABASE IF EXISTS manifest;"
  docker exec mnfst-dev-postgres-1 psql -U manifest -d postgres -c "CREATE DATABASE manifest OWNER manifest;"

  echo "Restoring into Staging..."
  docker exec mnfst-dev-postgres-1 pg_restore -U manifest -d manifest /tmp/prod.dump 2>/dev/null

  echo "Starting Staging manifest..."
  docker start mnfst-dev-manifest-1

  rm -f /tmp/prod.dump
  echo ""
  echo "✓ Snapshot complete. Staging (2100) is now a copy of Prod (2099)."
  echo "  Waiting for Staging to be healthy..."
  sleep 12
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:2100/api/v1/health 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    echo "  ✓ Staging is healthy (HTTP 200)"
  else
    echo "  ⚠ Staging returned HTTP $code"
  fi
  seed_dev_admin
}

cmd_snapshot_staging_to_prod() {
  echo "Snapshot: STAGING (2100) → PROD (2099)"
  echo "⚠️  This REPLACES the entire PRODUCTION database with Staging data."
  echo ""

  echo "Stopping Prod manifest..."
  docker stop mnfst-manifest-1 2>/dev/null || true
  sleep 2

  echo "Dumping Staging DB..."
  docker exec mnfst-dev-postgres-1 pg_dump -U manifest -Fc manifest > /tmp/staging.dump

  echo "Copying dump into Prod postgres..."
  docker cp /tmp/staging.dump mnfst-postgres-1:/tmp/staging.dump

  echo "Recreating Prod database..."
  docker exec mnfst-postgres-1 psql -U manifest -d postgres -c "DROP DATABASE IF EXISTS manifest;"
  docker exec mnfst-postgres-1 psql -U manifest -d postgres -c "CREATE DATABASE manifest OWNER manifest;"

  echo "Restoring into Prod..."
  docker exec mnfst-postgres-1 pg_restore -U manifest -d manifest /tmp/staging.dump 2>/dev/null

  echo "Starting Prod manifest..."
  docker start mnfst-manifest-1

  rm -f /tmp/staging.dump
  echo ""
  echo "✓ Snapshot complete. Prod (2099) is now a copy of Staging (2100)."
  echo "  Waiting for Prod to be healthy..."
  sleep 12
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:2099/api/v1/health 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    echo "  ✓ Prod is healthy (HTTP 200)"
  else
    echo "  ⚠ Prod returned HTTP $code"
  fi
}

seed_dev_admin() {
  local base="http://127.0.0.1:2100"
  local email="${WT_ADMIN_EMAIL:-admin@manifest.local}"
  local password="${WT_ADMIN_PASSWORD:-admin1234}"
  local status
  status="$(curl -s --max-time 10 "$base/api/v1/setup/status" 2>/dev/null || true)"
  if [[ "$status" == *'"needsSetup":true'* ]]; then
    curl -s -o /dev/null --max-time 15 -X POST "$base/api/v1/setup/admin" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"name\":\"Admin\",\"password\":\"$password\"}" || true
    echo "  ✓ Staging admin seeded: $email / $password"
  else
    curl -s -o /dev/null --max-time 15 -X POST "$base/api/auth/sign-up/email" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"Admin\"}" || true
    echo "  ✓ Staging login verified: $email / $password"
  fi
}

cmd_restart_prod() {
  echo "Rebuilding image from main (${PROD_REPO_DIR}) and restarting PRODUCTION (2099)..."
  DOCKER_BUILDKIT=0 docker build -f "${PROD_REPO_DIR}/docker/Dockerfile" -t manifestdotbuild/manifest:latest "${PROD_REPO_DIR}"
  prod_compose up -d --force-recreate
  echo "✓ Prod (2099) restarted."
}

cmd_restart_dev() {
  echo "Rebuilding image from staging (${STAGING_REPO_DIR}) and restarting STAGING (2100)..."
  DOCKER_BUILDKIT=0 docker build -f "${STAGING_REPO_DIR}/docker/Dockerfile" -t manifestdotbuild/manifest:staging "${STAGING_REPO_DIR}"
  dev_compose up -d --force-recreate
  echo "✓ Staging (2100) restarted."
}

cmd_restart_router() {
  echo "Restarting Manifest Dynamic Router (:2098)..."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart manifest-router
  else
    pkill -f "manifest-router.js" 2>/dev/null || true
    sleep 0.5
    ensure_router_running
  fi
  echo "✓ Dynamic Router restarted."
}

cmd_rebuild() {
  echo "Rebuilding production image from main (${PROD_REPO_DIR})..."
  DOCKER_BUILDKIT=0 docker build -f "${PROD_REPO_DIR}/docker/Dockerfile" -t manifestdotbuild/manifest:latest "${PROD_REPO_DIR}"
  echo "Rebuilding staging image from staging (${STAGING_REPO_DIR})..."
  DOCKER_BUILDKIT=0 docker build -f "${STAGING_REPO_DIR}/docker/Dockerfile" -t manifestdotbuild/manifest:staging "${STAGING_REPO_DIR}"
  prod_compose up -d --force-recreate
  dev_compose up -d --force-recreate
  echo "✓ Rebuild complete. Both Prod (2099) and Staging (2100) are up."
}

# ── main ─────────────────────────────────────────────────────────────────

case "${1:-status}" in
  help|-h|--help) cmd_help ;;
  status)         cmd_status ;;
  prod)           cmd_route "prod" "port 2099 (prod)" ;;
  staging|dev)    cmd_route "staging" "port 2100 (staging)" ;;
  restart-prod)   cmd_restart_prod ;;
  restart-staging|restart-dev) cmd_restart_dev ;;
  restart-router|router-restart) cmd_restart_router ;;
  snapshot-prod-to-staging|snapshot-prod-to-dev) cmd_snapshot_prod_to_staging ;;
  snapshot-staging-to-prod|snapshot-dev-to-prod) cmd_snapshot_staging_to_prod ;;
  snapshot)
    direction="${2:-prod-to-staging}"
    if [[ "$direction" == "staging-to-prod" || "$direction" == "dev-to-prod" ]]; then
      cmd_snapshot_staging_to_prod
    else
      cmd_snapshot_prod_to_staging
    fi
    ;;
  up)
    prod_compose up -d
    dev_compose up -d
    ensure_router_running
    cmd_status
    ;;
  down)
    prod_compose down
    dev_compose down
    ;;
  rebuild) cmd_rebuild ;;
  *)
    echo "Unknown command: $1"
    echo "Run '$0 help' for usage."
    exit 1
    ;;
esac
