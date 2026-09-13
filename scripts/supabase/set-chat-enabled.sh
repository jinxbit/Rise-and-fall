#!/usr/bin/env bash
#
# Flips public.app_config.chat_enabled to true over the Supabase Management
# API's query endpoint, the same mechanism register-database-webhook.sh
# already uses (POST {MANAGEMENT_API_URL}/v1/projects/{ref}/database/query
# with SUPABASE_ACCESS_TOKEN). deploy-supabase.yml calls this after
# `supabase db push`, and only when the resolved environment is not
# production (CHAT_PLAN.md §4, decided 2026-09-12): chat is enabled in
# pre-production automatically, so the flag doesn't need a manual SQL
# statement after every project reset, and is never enabled in production by
# any code path — production is turned on by exactly one hand-run
# `update public.app_config set chat_enabled = true;` in the SQL editor.
#
# The SQL is wrapped in a guard that no-ops if the table doesn't exist yet, so
# a deploy from a commit predating 0031_chat_messages.sql (or after a revert)
# doesn't fail here.
#
# Required env:
#   SUPABASE_PROJECT_ID    project ref (the api subdomain)
#   SUPABASE_ACCESS_TOKEN  Supabase personal access token
# Optional env:
#   MANAGEMENT_API_URL     defaults to https://api.supabase.com
#   DRY_RUN=1              print the SQL that would be sent and exit 0,
#                          without calling anything
#
# Exit codes:
#   0  chat_enabled set (or SQL printed, under DRY_RUN)
#   2  automation unavailable — the Management API query endpoint could not
#      be used. Callers should log and continue, not fail the deploy over
#      this — see this script's caller in deploy-supabase.yml.
#   1  the SQL itself failed, i.e. something is wrong that a retry of the
#      same run will not fix.

set -euo pipefail

fail_soft() { echo "::warning::$*" >&2; exit 2; }
fail_hard() { echo "::error::$*" >&2; exit 1; }

: "${SUPABASE_PROJECT_ID:?SUPABASE_PROJECT_ID is required}"

DRY_RUN="${DRY_RUN:-}"
MANAGEMENT_API_URL="${MANAGEMENT_API_URL:-https://api.supabase.com}"

if [ -z "$DRY_RUN" ]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
fi

sql="do \$\$ begin
  if to_regclass('public.app_config') is not null then
    update public.app_config set chat_enabled = true;
  end if;
end \$\$;"

if [ -n "$DRY_RUN" ]; then
  printf '%s\n' "$sql"
  exit 0
fi

command -v jq >/dev/null || fail_hard "jq is required"

request="$(jq -nc --arg q "$sql" '{query: $q}')"
response="$(curl -sS -w $'\n%{http_code}' \
  -X POST "${MANAGEMENT_API_URL}/v1/projects/${SUPABASE_PROJECT_ID}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "$request" 2>/dev/null || true)"
status="$(printf '%s' "$response" | tail -n1)"
body="$(printf '%s' "$response" | sed '$d')"

case "$status" in
  2*)
    echo "chat_enabled set to true on project ${SUPABASE_PROJECT_ID} (no-op if public.app_config doesn't exist yet)."
    ;;
  401|403)
    fail_soft "The Supabase Management API rejected SUPABASE_ACCESS_TOKEN (HTTP $status) — could not set chat_enabled."
    ;;
  *)
    fail_soft "The Supabase Management API query endpoint is unavailable (HTTP ${status:-no response}) — could not set chat_enabled. Response: $(printf '%s' "$body" | jq -r '.message? // .error? // .' 2>/dev/null | head -c 500)"
    ;;
esac
