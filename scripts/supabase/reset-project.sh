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
# `map_pool` is the one table here holding work a person did by hand that
# nothing can regenerate (src/pages/MapBuilderPage.tsx), so
# rebuild-preproduction.yml exports it with ./map-pool.sh before calling this
# and imports it back afterwards. This script itself makes no exception for
# it — it drops the schema, whole.
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
#   MODE=inventory                   report what is there and exit without changing anything.
#                                    Prints ONLY the JSON result, so a caller
#                                    can parse it; the prose belongs to the caller.
#   TOLERATE_MISSING=1               with MODE=inventory, report `{}` and warn instead of
#                                    failing when the schema isn't there to count (a project
#                                    that is already torn down, or half-way through a reset)
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
select jsonb_build_object(
  'auth_users',         (select count(*) from auth.users),
  'games',              (select count(*) from public.games),
  'players',            (select count(*) from public.players),
  'game_state',         (select count(*) from public.game_state),
  'profiles',           (select count(*) from public.profiles),
  'maps',               (select count(*) from public.map_pool),
  'admins',             (select count(*) from public.profiles where is_admin),
  'migrations_applied', (select count(*) from supabase_migrations.schema_migrations),
  'realtime_tables',    (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'),
  'in_progress_games',  coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',       g.name,
      'room_code',  g.room_code,
      'status',     g.status,
      'play_mode',  g.play_mode,
      'players',    (select count(*) from public.players p where p.game_id = g.id),
      'turn',       m.turn,
      'last_move',  to_char(coalesce(m.updated_at, g.updated_at), 'YYYY-MM-DD HH24:MI')
    ) order by coalesce(m.updated_at, g.updated_at) desc)
    from public.games g
    left join public.game_state_meta m on m.game_id = g.id
    where g.status in ('lobby', 'active')
  ), '[]'::jsonb)
) as inventory;
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

# `soft` (third arg) turns a failed query into a return 1 instead of exit 1 —
# used only by the pre-reset inventory, where "there is nothing to count" is a
# legitimate state (a project already torn down, or a reset that died
# half-way). The reset itself and the post-push verify never pass it.
run_query() {
  local sql="$1" label="$2" soft="${3:-}"
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
    *)
      local detail
      detail="$(printf '%s' "$body" | jq -r '.message? // .error? // .' 2>/dev/null | head -c 800)"
      if [ -n "$soft" ]; then
        echo "::warning::$label could not run (HTTP ${status:-no response}): $detail" >&2
        return 1
      fi
      fail "$label failed (HTTP ${status:-no response}): $detail"
      ;;
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

if [ "$MODE" = "inventory" ]; then
  # Only JSON on stdout: .github/workflows/rebuild-preproduction.yml parses
  # this, and an earlier version printed a heading above it that made every
  # `jq` in the caller silently yield nothing.
  if ! run_query "$inventory_sql" "inventory" soft; then
    if [ -n "${TOLERATE_MISSING:-}" ]; then
      echo '{}'
      exit 0
    fi
    fail "Could not take an inventory of project ${SUPABASE_PROJECT_ID}."
  fi
  exit 0
fi

echo "Inventory of project ${SUPABASE_PROJECT_ID} before any change:" >&2
run_query "$inventory_sql" "inventory" soft || echo "::warning::Nothing to inventory — continuing to the reset." >&2

echo "Dropping and recreating public schema on ${SUPABASE_PROJECT_ID}${WIPE_AUTH_USERS:+ (and deleting all auth users)}..."
run_query "$reset_sql" "reset"
echo "Schema dropped and recreated, migration history cleared. Run \`supabase db push\` next."
