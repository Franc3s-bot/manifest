#!/usr/bin/env bash
# switch-manifest.sh — Manage the Manifest Prod/Staging dual-stack setup.
#
# Two Manifest instances run side-by-side:
#   Port 2099 = Production  (stable, safe, snapshotted when ready)
#   Port 2100 = Staging     (validates the `staging` branch image before promotion)
#
# Staging runs the `manifest:staging` image (built from the `staging` branch);
# prod runs `manifest:latest` (built from `main`). When staging is stable,
# snapshot prod (2099) → staging (2100) for realistic data, then promote the
# staging branch to main via PR.
# OpenCode presets switch between "manifest" (prod) and "manifest-dev" (staging).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$REPO_DIR/docker"
PROD_COMPOSE="$DOCKER_DIR/docker-compose.yml"
DEV_COMPOSE="$DOCKER_DIR/docker-compose.dev.yml"
PROD_ENV="$DOCKER_DIR/.env"
DEV_ENV="$DOCKER_DIR/.env.dev"
OMOS_CONFIG="$HOME/.config/opencode/oh-my-opencode-slim.jsonc"

# ── helpers ──────────────────────────────────────────────────────────────

prod_compose() {
  docker compose -f "$PROD_COMPOSE" --project-directory "$DOCKER_DIR" --env-file "$PROD_ENV" "$@"
}

dev_compose() {
  docker compose -f "$DEV_COMPOSE" --project-directory "$DOCKER_DIR" --env-file "$DEV_ENV" "$@"
}

# ── commands ─────────────────────────────────────────────────────────────

cmd_help() {
  cat <<'EOF'
switch-manifest.sh — Manifest Prod/Staging dual-stack manager

USAGE
  switch-manifest.sh <command>

COMMANDS
  status       Show both stacks' health and the active OpenCode preset.
               This is the default when no command is given.

  prod         Switch OpenCode to the PRODUCTION preset (port 2099).
               All agents (orchestrator, fixer, explorer, etc.) will use
               the stable prod instance. Restart OpenCode after running.

  dev|staging  Switch OpenCode to the STAGING preset (port 2100).
               All agents use the staging instance (manifest:staging image)
               where you validate new features before promoting to main.
               Restart OpenCode after running.

  snapshot     Copy the production database into the STAGING instance (2099 → 2100).
               Use this when prod is stable and you want staging to match it,
               or before a big change so you have a clean baseline.
               ⚠️  This REPLACES the entire STAGING database.

  up           Start both stacks (prod + staging).

  down         Stop both stacks.

  rebuild      Rebuild the manifest image from source (prod: latest, staging:
               staging tag) and restart both stacks. Use after pulling new
               code or changing the healer.

  help         Show this help message.

WORKFLOW
  1. Develop on the staging branch, validate on Staging (2100):
       switch-manifest.sh dev     # point OpenCode at Staging
       # ... merge to staging, CI publishes manifest:staging, 2100 pulls it ...

  2. When stable, snapshot prod into staging or promote:
       switch-manifest.sh snapshot   # copy prod DB → staging
       switch-manifest.sh prod       # point OpenCode at prod
       # merge staging → main via PR, dispatch Docker workflow → latest → 2099

PORTS & CONTAINERS
  Prod:    2099 (manifest) / 3100 (healer) / 5432 (postgres)  — project: mnfst
  Staging: 2100 (manifest) / 3101 (healer) / 5432 (postgres)  — project: mnfst-dev

FILES
  docker/docker-compose.yml      Prod compose (manifest:latest)
  docker/docker-compose.dev.yml  Staging compose (manifest:staging)
  docker/.env                    Prod env (secrets, port 2099)
  docker/.env.dev                Staging env (secrets, port 2100)
  ~/.config/opencode/oh-my-opencode-slim.jsonc   Preset config
EOF
}

cmd_status() {
  echo "═══ Production (2099) ═══"
  prod_compose ps 2>/dev/null || echo "(not running)"
  check_stale_image prod
  echo ""
  echo "═══ Staging (2100) ═══"
  dev_compose ps 2>/dev/null || echo "(not running)"
  check_stale_image dev
  echo ""
  echo "═══ OpenCode preset ═══"
  local preset
  preset=$(grep -oP '"preset"\s*:\s*"\K[^"]+' "$OMOS_CONFIG" 2>/dev/null || echo "unknown")
  echo "Active: $preset"
  echo ""
  echo "Run 'switch-manifest.sh help' for usage."
}

cmd_switch_preset() {
  local target="$1"
  local label="$2"
  if [[ ! -f "$OMOS_CONFIG" ]]; then
    echo "ERROR: oh-my-opencode-slim config not found at $OMOS_CONFIG"
    exit 1
  fi
  sed -i "s/\"preset\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"preset\": \"$target\"/" "$OMOS_CONFIG"
  echo "✓ Switched OpenCode preset: $target ($label)"
  echo "  Restart OpenCode for the change to take effect."
}

cmd_snapshot() {
  echo "Snapshot: prod (2099) → staging (2100)"
  echo "⚠️  This REPLACES the entire STAGING database."
  echo ""

  echo "Stopping Staging manifest..."
  docker stop mnfst-dev-manifest-1 2>/dev/null || true
  sleep 2

  echo "Dumping prod DB (custom format)..."
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
  echo "✓ Snapshot complete. Staging (2100) is now a copy of prod (2099)."
  echo "  Waiting for Staging to be healthy..."
  sleep 15
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" http://100.69.158.7:2100/api/v1/health 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    echo "  ✓ Staging is healthy (HTTP 200)"
  else
    echo "  ⚠ Staging returned HTTP $code — check logs: docker logs mnfst-dev-manifest-1"
  fi
  seed_dev_admin
}

# seed_dev_admin — give the always-on Staging (2100) stack a predictable login so
# you never have to know prod credentials after a snapshot. Defaults
# admin@manifest.local / admin1234 (product enforces an 8-char min password);
# override with WT_ADMIN_EMAIL / WT_ADMIN_PASSWORD.
seed_dev_admin() {
  local base="http://100.69.158.7:2100"
  local email="${WT_ADMIN_EMAIL:-admin@manifest.local}"
  local password="${WT_ADMIN_PASSWORD:-admin1234}"
  echo "Seeding Staging login ($email / $password) ..."
  local status code
  status="$(curl -s --max-time 10 "$base/api/v1/setup/status" 2>/dev/null || true)"
  if [[ "$status" == *'"needsSetup":true'* ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$base/api/v1/setup/admin" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"name\":\"Admin\",\"password\":\"$password\"}")"
    if [[ "$code" == "200" || "$code" == "201" ]]; then
      echo "  ✓ Staging admin seeded — log in at $base with $email / $password"
    else
      echo "  ⚠ Setup admin returned HTTP $code — open $base/setup once to create the account."
    fi
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$base/api/auth/sign-up/email" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"Admin\"}")"
    if [[ "$code" == "200" || "$code" == "201" ]]; then
      echo "  ✓ Staging user seeded — log in at $base with $email / $password"
    else
      echo "  ✓ Staging login $email / $password assumed present (sign-up HTTP $code)."
    fi
  fi
}

# check_stale_image <prod|dev> — warn when the running manifest container's
# image differs from what the compose config currently resolves to, i.e. a
# restart/rebuild would silently swap in a different image. (dev == staging)
check_stale_image() {
  local tier="$1" ctr compose_file env_file
  if [[ "$tier" == "prod" ]]; then
    ctr="mnfst-manifest-1"; compose_file="$PROD_COMPOSE"; env_file="$PROD_ENV"
  else
    ctr="mnfst-dev-manifest-1"; compose_file="$DEV_COMPOSE"; env_file="$DEV_ENV"
  fi
  docker inspect "$ctr" >/dev/null 2>&1 || return 0
  [[ -f "$env_file" ]] || return 0
  local running declared
  running="$(docker inspect "$ctr" --format '{{.Config.Image}}' 2>/dev/null || true)"
  declared="$(docker compose -f "$compose_file" --project-directory "$DOCKER_DIR" --env-file "$env_file" config 2>/dev/null | grep 'image: manifestdotbuild/manifest' | awk '{print $2}' | head -n1 || true)"
  [[ -n "$running" && -n "$declared" && "$running" != "$declared" ]] || return 0
  echo ""
  echo "⚠️  STALE IMAGE WARNING — ${tier} (${ctr})"
  echo "    Running image:  ${running}"
  echo "    Declared image: ${declared}  (${env_file})"
  echo "    'services.sh restart' or 'switch-manifest.sh rebuild' would silently replace it."
  echo "    Recommend recording MANIFEST_VERSION=${running#*:} explicitly in ${env_file}."
  echo ""
}

cmd_restart_prod() {
  echo "Rebuilding image and restarting PRODUCTION (2099)..."
  docker build -f "$REPO_DIR/docker/Dockerfile" -t manifestdotbuild/manifest:latest "$REPO_DIR"
  prod_compose up -d --force-recreate
  echo "✓ Prod (2099) restarted."
}

cmd_restart_dev() {
  echo "Rebuilding image and restarting STAGING (2100)..."
  docker build -f "$REPO_DIR/docker/Dockerfile" -t manifestdotbuild/manifest:staging "$REPO_DIR"
  dev_compose up -d --force-recreate
  echo "✓ Staging (2100) restarted."
}

cmd_rebuild() {
  echo "Rebuilding manifest image..."
  docker build -f "$REPO_DIR/docker/Dockerfile" -t manifestdotbuild/manifest:latest "$REPO_DIR"
  echo "Restarting prod..."
  prod_compose up -d --force-recreate
  echo "Restarting dev/staging..."
  dev_compose up -d --force-recreate
  cmd_status
}

# ── main ─────────────────────────────────────────────────────────────────

case "${1:-status}" in
  help|-h|--help)  cmd_help ;;
  status)          cmd_status ;;
  prod)            cmd_switch_preset "manifest" "port 2099" ;;
  dev|staging)     cmd_switch_preset "manifest-dev" "port 2100 (staging)" ;;
  restart-prod)    cmd_restart_prod ;;
  restart-dev|restart-staging) cmd_restart_dev ;;
  snapshot)        cmd_snapshot ;;
  up)
    prod_compose up -d
    dev_compose up -d
    cmd_status
    ;;
  down)
    prod_compose down
    dev_compose down
    ;;
  rebuild)         cmd_rebuild ;;
  *)
    echo "Unknown command: $1"
    echo "Run '$0 help' for usage."
    exit 1
    ;;
esac
