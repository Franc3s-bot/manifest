#!/usr/bin/env bash
# services.sh — Start or restart the Manifest Prod/Staging dual-stack services.
#
#   services.sh start     Start both stacks (prod 2099 + staging 2100)
#   services.sh restart   Restart both stacks (recreate containers, no image rebuild)
#   services.sh help      Show this help
#
# For image rebuilds (after code changes): ./scripts/switch-manifest.sh rebuild
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$REPO_DIR/docker"
PROD_COMPOSE="$DOCKER_DIR/docker-compose.yml"
DEV_COMPOSE="$DOCKER_DIR/docker-compose.dev.yml"
PROD_ENV="$DOCKER_DIR/.env"
DEV_ENV="$DOCKER_DIR/.env.dev"

# Dedicated source checkouts per stack (same convention as switch-manifest.sh).
PROD_REPO_DIR="${PROD_REPO_DIR:-/root/projects/manifest}"
STAGING_REPO_DIR="${STAGING_REPO_DIR:-/root/projects/manifest-staging}"
[[ -d "$STAGING_REPO_DIR" ]] || STAGING_REPO_DIR="$REPO_DIR"
[[ -d "$PROD_REPO_DIR" ]] || PROD_REPO_DIR="$REPO_DIR"

prod_compose() {
  local dir="${PROD_REPO_DIR}/docker"
  docker compose -f "$dir/docker-compose.yml" --project-directory "$dir" --env-file "$dir/.env" "$@"
}

dev_compose() {
  local dir="${STAGING_REPO_DIR}/docker"
  docker compose -f "$dir/docker-compose.dev.yml" --project-directory "$dir" --env-file "$dir/.env.dev" "$@"
}

cmd_start() {
  echo "Starting prod (2099) + staging (2100)..."
  prod_compose up -d
  dev_compose up -d
}

cmd_restart() {
  echo "Restarting prod (2099) + staging (2100)..."
  prod_compose up -d --force-recreate
  dev_compose up -d --force-recreate
}

cmd_help() {
  cat <<'EOF'
services.sh — Start or restart Manifest Prod/Staging services

USAGE
  services.sh <command>

COMMANDS
  start      Start both stacks (prod 2099 + staging 2100). Safe to re-run.
  restart    Restart both stacks (recreate containers, no image rebuild).
  help       Show this help.

NOTE
  After code changes, rebuild the image first:
    ./scripts/switch-manifest.sh rebuild
EOF
}

case "${1:-help}" in
  start|staging) cmd_start ;;
  restart|restart-staging) cmd_restart ;;
  help|-h|--help) cmd_help ;;
  *)
    echo "Unknown command: $1"
    echo "Run 'services.sh help' for usage."
    exit 1
    ;;
esac

echo ""
"$REPO_DIR/scripts/switch-manifest.sh" status
