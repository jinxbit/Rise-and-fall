#!/usr/bin/env bash
#
# Moves `map_pool` rows between Supabase projects, over the Management API's
# query endpoint — the same mechanism reset-project.sh, set-chat-enabled.sh
# and register-database-webhook.sh already use, so it needs no database
# password and no direct network path to Postgres.
#
# Two jobs, one body of code:
#
#   MODE=export   print this project's maps as JSON on stdout
#   MODE=import   insert maps (MAPS_FILE, or stdin) into this project
#   MODE=copy     export from SOURCE_PROJECT_ID, import into TARGET_PROJECT_ID
#
# WHY IT EXISTS: `map_pool` is the one table holding work a person did by hand
# (src/pages/MapBuilderPage.tsx) that nothing else can regenerate.
# rebuild-preproduction.yml drops `public` cascade, which takes the maps with
# it, so it exports them first and imports them back afterwards (MODE=export /
# MODE=import). MODE=copy is the other direction of the same problem: seeding
# pre-production with maps that only exist in production.
#
# WHAT TRAVELS, AND WHAT DOESN'T. A row is `player_count`, `board` (pure
# terrain data) and `board_key` (canonicalizeBoard's signature of that board,
# src/engine/board.ts). Three things are deliberately NOT carried across:
#
#   * `id`. Nothing depends on it surviving — `games.settings.mapPoolMapId` is
#     display-only (gameApi.ts), and what a game actually stores is
#     `mapPoolBoard`, its own copy of the board. Letting the target generate
#     fresh ids avoids colliding with rows already there.
#   * `created_at`. The import is a new event in the target's history, and
#     pretending otherwise would misdate it.
#   * `created_by`. This is the only real obstacle to a straight row copy:
#     it is `not null references auth.users (id)` and auth user ids are
#     per-project, so the source's value is meaningless in the target.
#     TARGET_CREATED_BY names a replacement; without one the import adopts the
#     target's oldest account. No account at all (a rebuild that also wiped
#     auth) is not an error — the import no-ops and says so, leaving the
#     exported JSON for a later run.
#
# `board_key` is copied verbatim rather than recomputed, so two deploys on
# different engine versions can never disagree about a map's signature. That
# plus `unique (player_count, board_key)` (0016_map_pool.sql) makes an import
# idempotent: re-running it inserts nothing.
#
# WRITES NEVER REACH PRODUCTION. Reading production is the point of MODE=copy
# and is safe; writing to it is refused outright, and a missing
# PRODUCTION_SUPABASE_PROJECT_ID is treated as a broken guard rather than an
# absent one — the 2026-09-09 reasoning in deploy-supabase.yml, where an
# environment lacking its own project ref silently inherited production's.
#
# Required env:
#   SUPABASE_ACCESS_TOKEN            Supabase personal access token
#   PRODUCTION_SUPABASE_PROJECT_ID   production's ref, for the write guard
#   SUPABASE_PROJECT_ID              the project to read (export) or write (import)
#   SOURCE_PROJECT_ID/TARGET_PROJECT_ID   instead of the above, for MODE=copy
# Optional env:
#   MAPS_FILE          MODE=import: where to read the JSON from (default stdin)
#   TARGET_CREATED_BY  uuid to own the imported rows
#   DRY_RUN=1          report and print the SQL, change nothing
#   MANAGEMENT_API_URL defaults to https://api.supabase.com

set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

MODE="${MODE:-export}"
DRY_RUN="${DRY_RUN:-}"
MANAGEMENT_API_URL="${MANAGEMENT_API_URL:-https://api.supabase.com}"

case "$MODE" in
  export) SOURCE="${SOURCE_PROJECT_ID:-${SUPABASE_PROJECT_ID:-}}"; TARGET="" ;;
  import) SOURCE=""; TARGET="${TARGET_PROJECT_ID:-${SUPABASE_PROJECT_ID:-}}" ;;
  copy) SOURCE="${SOURCE_PROJECT_ID:-}"; TARGET="${TARGET_PROJECT_ID:-}" ;;
  *) fail "MODE must be export, import or copy (got '$MODE')" ;;
esac

[ -n "${SOURCE:-}${TARGET:-}" ] || fail "No project ref: set SUPABASE_PROJECT_ID (export/import) or SOURCE_PROJECT_ID/TARGET_PROJECT_ID (copy)."
[ "$MODE" != 'copy' ] || [ -n "$SOURCE" ] || fail "MODE=copy needs SOURCE_PROJECT_ID."
[ "$MODE" != 'copy' ] || [ -n "$TARGET" ] || fail "MODE=copy needs TARGET_PROJECT_ID."
[ "$MODE" != 'copy' ] || [ "$SOURCE" != "$TARGET" ] || fail "SOURCE_PROJECT_ID and TARGET_PROJECT_ID are the same project ('$SOURCE')."

# --- The write guard, checked even under DRY_RUN ---------------------------
if [ -n "$TARGET" ]; then
  [ -n "${PRODUCTION_SUPABASE_PROJECT_ID:-}" ] || fail "PRODUCTION_SUPABASE_PROJECT_ID is not set, so the guard that keeps writes away from production cannot work."
  [ "$TARGET" != "$PRODUCTION_SUPABASE_PROJECT_ID" ] || fail "Refusing to write maps into project '$TARGET' — that IS production. This script only ever reads it."
fi

command -v jq >/dev/null || fail "jq is required"
if [ -z "$DRY_RUN" ]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
fi

run_query() {
  local ref="$1" sql="$2" label="$3"
  local request response status body
  request="$(jq -nc --arg q "$sql" '{query: $q}')"
  response="$(curl -sS -w $'\n%{http_code}' \
    -X POST "${MANAGEMENT_API_URL}/v1/projects/${ref}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$request" 2>/dev/null || true)"
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  case "$status" in
    2*) printf '%s' "$body" ;;
    401|403) fail "The Management API rejected SUPABASE_ACCESS_TOKEN (HTTP $status) during: $label" ;;
    *) fail "$label failed (HTTP ${status:-no response}): $(printf '%s' "$body" | jq -r '.message? // .error? // .' 2>/dev/null | head -c 800)" ;;
  esac
}

EXPORT_SQL="select player_count, board, board_key from public.map_pool order by created_at;"

do_export() {
  if [ -n "$DRY_RUN" ]; then printf '%s\n' "$EXPORT_SQL"; return; fi
  run_query "$SOURCE" "$EXPORT_SQL" "map_pool export from $SOURCE"
}

do_import() {
  local maps_json="$1" count owner_clause tag='mp_payload'
  count="$(printf '%s' "$maps_json" | jq 'length')"
  if [ "${count:-0}" -eq 0 ]; then
    echo "No maps to import — nothing to do." >&2
    return 0
  fi
  # Dollar-quoted so the board JSON needs no SQL escaping. Refuse rather than
  # risk a payload that would close the quote early.
  printf '%s' "$maps_json" | grep -qF "\$${tag}\$" && fail "Map JSON contains the dollar-quote tag '\$${tag}\$' — refusing to build SQL around it."

  if [ -n "${TARGET_CREATED_BY:-}" ]; then
    owner_clause="'${TARGET_CREATED_BY}'::uuid"
  else
    # The target's oldest account. `where exists` below makes a project with no
    # accounts at all a silent no-op rather than a foreign-key error.
    owner_clause="(select id from auth.users order by created_at limit 1)"
  fi

  local sql="insert into public.map_pool (player_count, board, board_key, created_by)
select (r->>'player_count')::int, r->'board', r->>'board_key', ${owner_clause}
from jsonb_array_elements(\$${tag}\$${maps_json}\$${tag}\$::jsonb) as r
where ${owner_clause} is not null
on conflict (player_count, board_key) do nothing;"

  if [ -n "$DRY_RUN" ]; then
    echo "-- would insert ${count} map(s) into ${TARGET}" 
    printf '%s\n' "$sql"
    return
  fi
  run_query "$TARGET" "$sql" "map_pool import into $TARGET" >/dev/null
  local after
  after="$(run_query "$TARGET" "select count(*) as maps, (select count(*) from auth.users) as users from public.map_pool;" "map_pool count in $TARGET")"
  local maps users
  maps="$(printf '%s' "$after" | jq -r '.[0].maps')"
  users="$(printf '%s' "$after" | jq -r '.[0].users')"
  if [ "${users:-0}" -eq 0 ]; then
    echo "::warning::${TARGET} has no auth users, so ${count} map(s) could not be given an owner and were NOT imported. Sign in once, then re-run this import with the exported JSON." >&2
  else
    echo "Imported ${count} map(s) into ${TARGET}; it now holds ${maps} (duplicates are skipped by unique (player_count, board_key))." >&2
  fi
}

case "$MODE" in
  export) do_export ;;
  import)
    if [ -n "${MAPS_FILE:-}" ]; then
      [ -f "$MAPS_FILE" ] || fail "MAPS_FILE '$MAPS_FILE' does not exist."
      do_import "$(cat "$MAPS_FILE")"
    else
      do_import "$(cat)"
    fi
    ;;
  copy)
    if [ -n "$DRY_RUN" ]; then
      echo "-- would read from ${SOURCE} and write to ${TARGET} (production is ${PRODUCTION_SUPABASE_PROJECT_ID})"
      printf '%s\n' "$EXPORT_SQL"
      exit 0
    fi
    do_import "$(run_query "$SOURCE" "$EXPORT_SQL" "map_pool export from $SOURCE")"
    ;;
esac
