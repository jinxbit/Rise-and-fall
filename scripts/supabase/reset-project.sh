#!/usr/bin/env bash
#
# Drops and rebuilds a Supabase project's `public` schema so the next
# `supabase db push` re-applies every migration from scratch — the
# "drop everything and reinstall" half of .github/workflows/rebuild-preproduction.yml.
#
# Runs over the Management API's query endpoint, the same mechanism
# set-chat-enabled.sh and register-database-webhook.sh already use (POST
# {MANAGEMENT_API_URL}/v1/projects/{ref}/database/query with
# SUPABASE_ACCESS_TOKEN), so it needs no database password and no direct
# network path to Postgres.
#
# WHY A RESET IS EVER WANTED: pre-production accumulates state that no
# migration describes — throwaway smoke users and rooms, hand-run SQL, and
# (the case this was written for, todo.md #139) a migration applied on the
# project that has since been reverted out of the repository, leaving a
# `supabase_migrations.schema_migrations` row with no file behind it. Rather
# than reconcile that by hand, rebuild from the migrations and let the repo
# be the only source of truth.
#
# WHAT IT DESTROYS: everything in `public` — games, players, game_state,
# profiles (including `is_admin`, which 0017_admin_delete_any_game.sql says
# is granted by hand and is therefore NOT restored by a db push), chat,
# push_subscriptions, map_pool. Also clears the migration history so every
# migration re-applies.
#
# WHAT IT LEAVES ALONE: the `auth` schema (accounts, identities, sessions)
# unless WIPE_AUTH_USERS=1, `storage`, and the `supabase_realtime`
# publication itself. Dropping the tables removes them from that publication;
# the migrations re-add them idempotently on the way back up
# (0001_init_schema.sql, 0025_game_state_meta.sql, 0031_chat_messages.sql all
# guard their `alter publication` with a `not exists` check), so Realtime
# comes back without manual help.
#
# Required env:
#   SUPABASE_PROJECT_ID              project ref to reset (the api subdomain)
#   PRODUCTION_SUPABASE_PROJECT_ID   production's ref — this script REFUSES to
#                                    run when the two match. Not optional:
#                                    an unset guard is treated as a broken
#                                    guard, for the same reason
#                                    deploy-supabase.yml's "Refuse to touch
#                                    the wrong project" treats it that way
#                                    (the 2026-09-09 incident, where an
#                                    environment missing its own project ref
#                                    inherited production's).
#   SUPABASE_ACCESS_TOKEN            Supabase personal access token (not needed under DRY_RUN)
# Optional env:
#   MODE=inventory                   report what is there and exit without changing anything
#   WIPE_AUTH_USERS=1                also delete every row in auth.users
#   DRY_RUN=1                        print the SQL that would be sent and exit 0
#   MANAGEMENT_API_URL               defaults to https://api.supabase.com
#
# Exit codes:
#   0  done (or SQL printed, under DRY_RUN)
#   1  refused, or the SQL failed. Unlike set-chat-enabled.sh there is no
#      soft-fail arm: a half-applied reset must fail the run loudly rather
#      than let a later `db push` land on a schema in an unknown state.

set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

: "${SUPABASE_PROJECT_ID:?SUPABASE_PROJECT_ID is required}"

MODE="${MODE:-reset}"
DRY_RUN="${DRY_RUN:-}"
WIPE_AUTH_USERS="${WIPE_AUTH_USERS:-}"
MANAGEMENT_API_URL="${MANAGEMENT_API_URL:-https://api.supabase.com}"

# --- Guards ---------------------------------------------------------------
# Checked before anything else, and checked even under DRY_RUN: a dry run
# that prints "here is the SQL I would run against production" is already a
# bug worth failing on.
if [ -z "${PRODUCTION_SUPABASE_PROJECT_ID:-}" ]; then
  fail "PRODUCTION_SUPABASE_PROJECT_ID is not set, so the guard that keeps this away from production cannot work. Set the repository variable (Settings -> Secrets and variables -> Actions -> Variables) to the production project ref."
fi
if [ "$SUPABASE_PROJECT_ID" = "$PRODUCTION_SUPABASE_PROJECT_ID" ]; then
  fail "Refusing to reset project '$SUPABASE_PROJECT_ID' — that IS production. This script never runs against production, whatever the caller says."
fi

if [ -z "$DRY_RUN" ]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
  command -v jq >/dev/null || fail "jq is required"
fi

# --- SQL ------------------------------------------------------------------
# Every table this app owns, counted before it goes, so the run log records
# what was destroyed rather than just that something was. to_regclass keeps
# it working against a project that is already partly torn down.
read -r -d '' inventory_sql <<'SQL' || true
select
  (select count(*) from auth.users)                                                    as auth_users,
  coalesce((select count(*) from public.games), -1)                                    as games,
  coalesce((select count(*) from public.players), -1)                                  as players,
  coalesce((select count(*) from public.game_state), -1)                               as game_state,
  coalesce((select count(*) from public.profiles), -1)                                 as profiles,
  coalesce((select count(*) from public.profiles where is_admin), -1)                  as admins,
  (select count(*) from supabase_migrations.schema_migrations)                          as migrations_applied,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime')      as realtime_tables;
SQL

# `drop schema public cascade` takes the tables, views, functions, triggers,
# types and sequences with it, and removes the tables from
# supabase_realtime. The recreate restores the grants a stock Supabase
# project ships with — without them PostgREST answers every request with a
# permission error, which looks like a broken deploy rather than a missing
# grant, so they are spelled out here rather than assumed.
reset_sql="drop schema if exists public cascade;

create schema public;
alter schema public owner to pg_database_owner;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- Clearing the history is what makes \`supabase db push\` re-apply everything.
-- Without it the CLI believes all 36 migrations are already applied, pushes
-- nothing, and leaves an empty schema behind — the failure mode this whole
-- script exists to avoid.
delete from supabase_migrations.schema_migrations;"

if [ -n "$WIPE_AUTH_USERS" ]; then
  # Cascades to auth.identities / auth.sessions / auth.refresh_tokens via
  # their own foreign keys. Note this invalidates any is_admin grant you
  # planned to restore by UUID — the accounts come back with new ids.
  reset_sql="$reset_sql

delete from auth.users;"
fi

run_query() {
  local sql="$1" label="$2"
  local request response status body
  request="$(jq -nc --arg q "$sql" '{query: $q}')"
  response="$(curl -sS -w $'\n%{http_code}' \
    -X POST "${MANAGEMENT_API_URL}/v1/projects/${SUPABASE_PROJECT_ID}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$request" 2>/dev/null || true)"
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  case "$status" in
    2*) printf '%s\n' "$body" | jq . 2>/dev/null || printf '%s\n' "$body" ;;
    401|403) fail "The Management API rejected SUPABASE_ACCESS_TOKEN (HTTP $status) during: $label" ;;
    *) fail "$label failed (HTTP ${status:-no response}): $(printf '%s' "$body" | jq -r '.message? // .error? // .' 2>/dev/null | head -c 800)" ;;
  esac
}

if [ -n "$DRY_RUN" ]; then
  echo "--- would run against project ${SUPABASE_PROJECT_ID} (production is ${PRODUCTION_SUPABASE_PROJECT_ID}) ---"
  echo "--- inventory ---"
  printf '%s\n\n' "$inventory_sql"
  [ "$MODE" = "inventory" ] && exit 0
  echo "--- reset ---"
  printf '%s\n' "$reset_sql"
  exit 0
fi

echo "Inventory of project ${SUPABASE_PROJECT_ID} before any change:"
run_query "$inventory_sql" "inventory"

if [ "$MODE" = "inventory" ]; then
  echo "MODE=inventory — nothing changed."
  exit 0
fi

echo "Dropping and recreating public schema on ${SUPABASE_PROJECT_ID}${WIPE_AUTH_USERS:+ (and deleting all auth users)}..."
run_query "$reset_sql" "reset"
echo "Schema dropped and recreated, migration history cleared. Run \`supabase db push\` next."
