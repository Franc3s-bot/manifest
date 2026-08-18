#!/usr/bin/env bash
#
# seed-council-tiers.sh — Create the 3 council header tiers for the `opencode`
# agent in the STAGING manifest database (container: mnfst-dev-postgres-1).
#
# Each tier becomes a synthetic `auto-<name>` model in the manifest router
# (requesting `model: auto-council-alpha` selects that tier). The tiers give
# the Paseo Coordinator's council three genuinely distinct model families,
# verified working on staging:
#
#   council-alpha  → OpenAI (GPT-5.6 Sol subscription)   via commandcode
#   council-beta   → Google (Gemini 3.5 Flash Lite)      via gemini
#   council-gamma  → Qwen  (Qwen 3.6 27B)               via groq
#
# Idempotent: safe to re-run; existing rows are not duplicated. Requires the
# staging postgres container to be running.
#
# Usage: ./scripts/seed-council-tiers.sh

set -euo pipefail

STAGING_PG="${STAGING_PG:-mnfst-dev-postgres-1}"
DB_USER="${DB_USER:-manifest}"
DB_NAME="${DB_NAME:-manifest}"

AGENT_ID="d03792c0-ec0f-4f2c-bb50-0ab7f1248616"   # opencode agent (staging)
TENANT_ID="3600be3e-b948-4831-9f50-11f595125023"

psql_exec() {
  docker exec "${STAGING_PG}" psql -U "${DB_USER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1 "$@"
}

echo "==> Checking staging postgres container '${STAGING_PG}' is up..."
docker inspect "${STAGING_PG}" >/dev/null 2>&1 || {
  echo "ERROR: staging postgres container '${STAGING_PG}' not found." >&2
  echo "Start the staging stack with: ./scripts/switch-manifest.sh up" >&2
  exit 1
}

echo "==> Verifying opencode agent row exists..."
agent_count="$(psql_exec -tAc "SELECT COUNT(*) FROM agents WHERE id='${AGENT_ID}' AND tenant_id='${TENANT_ID}' AND deleted_at IS NULL;")"
if [[ "${agent_count}" != "1" ]]; then
  echo "ERROR: expected exactly 1 opencode agent row for ${AGENT_ID}; found ${agent_count}." >&2
  exit 1
fi

insert_tier() {
  local name="$1" header_value="$2" color="$3" model_id="$4" provider="$5" auth_type="$6" key_label="$7"
  local existing
  existing="$(psql_exec -tAc "SELECT COUNT(*) FROM header_tiers WHERE agent_id='${AGENT_ID}' AND LOWER(name)=LOWER('${name}');")"
  if [[ "${existing}" != "0" ]]; then
    echo "==> Tier '${name}' already exists — skipping (count=${existing})."
    return
  fi
  local next_order
  next_order="$(psql_exec -tAc "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM header_tiers WHERE agent_id='${AGENT_ID}';")"
  echo "==> Creating tier '${name}' (order ${next_order}) → ${model_id}"
  psql_exec -c "
    INSERT INTO header_tiers (
      id, tenant_id, agent_id, name, header_key, header_value, badge_color,
      sort_order, enabled, override_route, fallback_routes,
      output_modality, response_mode, created_at, updated_at
    ) VALUES (
      gen_random_uuid()::text,
      '${TENANT_ID}',
      '${AGENT_ID}',
      '${name}',
      'x-manifest-complexity',
      '${header_value}',
      '${color}',
      ${next_order},
      true,
      '{\"model\": \"${model_id}\", \"provider\": \"${provider}\", \"authType\": \"${auth_type}\", \"keyLabel\": \"${key_label}\"}'::jsonb,
      NULL,
      'text',
      'buffered',
      NOW(),
      NOW()
    );
  "
}

insert_tier "council-alpha" "council-alpha" "sky"    "commandcode/gpt-5.6-sol" "commandcode" "subscription" "Dev"
insert_tier "council-beta"  "council-beta"  "orange" "gemini-3.5-flash-lite"  "gemini"      "api_key"      "rotation"
insert_tier "council-gamma" "council-gamma" "teal"   "qwen/qwen3.6-27b"       "groq"        "api_key"      "rotation"

echo
echo "==> Done. Tiers now present for opencode agent:"
psql_exec -c "
  SELECT name, header_key, header_value, badge_color, sort_order, enabled, override_route
  FROM header_tiers
  WHERE agent_id='${AGENT_ID}' AND name LIKE 'council-%'
  ORDER BY sort_order;
"
