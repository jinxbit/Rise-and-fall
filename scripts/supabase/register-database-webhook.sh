#!/usr/bin/env bash
#
# Registers (or re-registers) Supabase Database Webhooks for one Edge
# Function, without touching the dashboard.
#
# A "Database Webhook" is not a separate Supabase object: the dashboard's
# Database -> Webhooks screen creates an ordinary Postgres trigger that calls
# `supabase_functions.http_request(url, method, headers_json, params_json,
# timeout_ms)`. audit-and-fix-migrations.yml already relies on that fact (it
# redacts those trigger definitions out of schema dumps, because the
# `x-webhook-secret` header value is stored in them in plaintext — pg_dump
# masks `Authorization` and nothing else). So anything the dashboard can
# register, SQL can register too, which is what this script does: it sends
# the SQL over the Supabase Management API's query endpoint using the same
# SUPABASE_ACCESS_TOKEN the setup workflows already hold.
#
# Why this exists at all: before it, every "Set Up ... Notifications"
# workflow stopped one step short and printed "now go create N hooks in the
# dashboard and paste this secret into each". For the lifecycle
# notifications (issue #77) that was six hooks per Supabase project, each
# with a hand-pasted secret — the step most likely to be got wrong, and the
# reason rotating a webhook secret was a chore rather than a button.
#
# Registration is idempotent and rotation-safe. WEBHOOK_HOOKS describes the
# function's hooks in full, not an addition to them: every existing
# http_request trigger pointing at this function is dropped first, whatever
# table it is on and whatever it is called, so
#   - re-running with a fresh secret updates the header instead of stacking
#     a second hook (which would double every notification),
#   - a hook originally created by hand in the dashboard is adopted rather
#     than duplicated, and
#   - a hook on a table the function has stopped watching is removed (this is
#     what retires the lifecycle functions' old `game_state` hooks, todo.md
#     #100) instead of invoking it for nothing on every write.
# The match is on the function URL *including its closing quote*, so
# `notify-web-push` never matches `notify-web-push-lifecycle`.
#
# Required env:
#   SUPABASE_PROJECT_ID    project ref (the api subdomain)
#   SUPABASE_ACCESS_TOKEN  Supabase personal access token
#   FUNCTION_NAME          e.g. notify-discord-lifecycle
#   WEBHOOK_SECRET         value for the x-webhook-secret header
#   WEBHOOK_HOOKS          space-separated <table>:<EVENT>[,<EVENT>] list,
#                          e.g. "players:INSERT games:UPDATE game_state:UPDATE"
# Optional env:
#   SUPABASE_ANON_KEY      Authorization: Bearer value for the hook. Deployed
#                          functions verify a JWT unless configured otherwise,
#                          so the hook has to send one — the dashboard fills
#                          this in for you. Left unset, the script copies the
#                          header off an existing webhook trigger, and failing
#                          that asks the Management API for the anon key.
#   SUPABASE_API_URL       defaults to https://<ref>.supabase.co
#   MANAGEMENT_API_URL     defaults to https://api.supabase.com
#   WEBHOOK_DRY_RUN=1      print the SQL that would be sent and exit 0,
#                          without calling anything (this is also the SQL to
#                          paste into the dashboard's SQL editor by hand)
#
# Exit codes:
#   0  hooks registered (or SQL printed, under WEBHOOK_DRY_RUN)
#   2  automation unavailable — the Management API query endpoint could not
#      be used, or no Authorization header could be resolved. Callers should
#      fall back to printing the manual dashboard instructions; nothing was
#      changed.
#   1  the SQL itself failed, i.e. something is wrong that a retry of the
#      same run will not fix.

set -euo pipefail

fail_soft() { echo "::warning::$*" >&2; exit 2; }
fail_hard() { echo "::error::$*" >&2; exit 1; }

: "${SUPABASE_PROJECT_ID:?SUPABASE_PROJECT_ID is required}"
: "${FUNCTION_NAME:?FUNCTION_NAME is required}"
: "${WEBHOOK_SECRET:?WEBHOOK_SECRET is required}"
: "${WEBHOOK_HOOKS:?WEBHOOK_HOOKS is required}"

DRY_RUN="${WEBHOOK_DRY_RUN:-}"
MANAGEMENT_API_URL="${MANAGEMENT_API_URL:-https://api.supabase.com}"
SUPABASE_API_URL="${SUPABASE_API_URL:-https://${SUPABASE_PROJECT_ID}.supabase.co}"
FUNCTION_URL="${SUPABASE_API_URL%/}/functions/v1/${FUNCTION_NAME}"

if [ -z "$DRY_RUN" ]; then
  : "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
fi

# --- Management API plumbing -------------------------------------------------

# Runs one SQL string, leaving the response body in $api_body and the HTTP
# status in $api_status — deliberately not echoing the body, because a
# command substitution would run this in a subshell and lose the status,
# which is exactly the half the caller needs to tell "no rows" from "the
# endpoint is not there". Whether a non-2xx is fatal is the caller's call.
api_status=''
api_body=''
api_sql() {
  local sql="$1" request response
  request="$(jq -nc --arg q "$sql" '{query: $q}')"
  response="$(curl -sS -w $'\n%{http_code}' \
    -X POST "${MANAGEMENT_API_URL}/v1/projects/${SUPABASE_PROJECT_ID}/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data "$request" 2>/dev/null || true)"
  api_status="$(printf '%s' "$response" | tail -n1)"
  api_body="$(printf '%s' "$response" | sed '$d')"
}

# The endpoint returns rows as a JSON array, but has been wrapped differently
# across Management API revisions. Pull the first value of a named column out
# of whatever shape came back rather than assuming the top level is the array.
first_value() {
  jq -r --arg k "$1" '[.. | objects | select(has($k)) | .[$k] | values] | first // empty' 2>/dev/null || true
}

# --- Resolve the Authorization header ----------------------------------------
#
# Deployed Edge Functions verify a JWT by default, so a hook that sends only
# x-webhook-secret gets a 401 before the function ever runs. The dashboard
# hides this by filling the header in for you; here it has to be resolved.

AUTH_HEADER=''
resolve_auth_header() {
  if [ -n "${SUPABASE_ANON_KEY:-}" ]; then
    AUTH_HEADER="Bearer ${SUPABASE_ANON_KEY}"
    echo "Authorization header: taken from the SUPABASE_ANON_KEY input." >&2
    return 0
  fi

  # Preferred when this project already has a working hook (the turn
  # notifications, usually): copy the header that is demonstrably accepted
  # rather than deriving a fresh one that might be a different key format.
  local existing
  api_sql "select (regexp_match(pg_get_triggerdef(t.oid), '\"Authorization\"\\s*:\\s*\"([^\"]+)\"'))[1] as auth
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where not t.tgisinternal and n.nspname = 'supabase_functions' and p.proname = 'http_request'
  and pg_get_triggerdef(t.oid) like '%Authorization%'
limit 1"
  existing="$(printf '%s' "$api_body" | first_value auth)"
  if [ -n "$existing" ]; then
    AUTH_HEADER="$existing"
    echo "Authorization header: copied from an existing Database Webhook on this project." >&2
    return 0
  fi

  local keys anon
  keys="$(curl -sS "${MANAGEMENT_API_URL}/v1/projects/${SUPABASE_PROJECT_ID}/api-keys?reveal=true" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" 2>/dev/null || true)"
  anon="$(printf '%s' "$keys" | jq -r '[.. | objects | select((.name? // "") == "anon") | (.api_key? // .apiKey?) | values] | first // empty' 2>/dev/null || true)"
  if [ -n "$anon" ]; then
    echo "::add-mask::$anon"
    AUTH_HEADER="Bearer ${anon}"
    echo "Authorization header: fetched the project's anon key from the Management API." >&2
    return 0
  fi

  return 1
}

# --- SQL generation ----------------------------------------------------------

sql_literal() { printf "'%s'" "${1//\'/\'\'}"; }

build_sql() {
  local headers_json trigger_name table events event
  headers_json="$(jq -nc --arg auth "$AUTH_HEADER" --arg secret "$WEBHOOK_SECRET" \
    '{"Content-Type": "application/json", "Authorization": $auth, "x-webhook-secret": $secret}')"

  # Drop every trigger already pointing at this function, on any table, before
  # creating the listed ones — the function's hooks end up being exactly what
  # WEBHOOK_HOOKS says and nothing else. That makes this the whole update, not
  # just an addition: a hook made by hand under some other name is adopted
  # rather than duplicated (a duplicate would double every notification), and
  # a hook on a table the function has stopped watching is cleaned up instead
  # of being left to invoke it for nothing.
  cat <<SQL
do \$register\$
declare existing record;
begin
  for existing in
    select tg.tgname, cl.relname, nsp.nspname
    from pg_trigger tg
    join pg_class cl on cl.oid = tg.tgrelid
    join pg_namespace nsp on nsp.oid = cl.relnamespace
    join pg_proc p on p.oid = tg.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not tg.tgisinternal
      and pn.nspname = 'supabase_functions' and p.proname = 'http_request'
      and pg_get_triggerdef(tg.oid) like $(sql_literal "%${FUNCTION_URL}'%")
  loop
    raise notice 'replacing existing webhook trigger % on %.%', existing.tgname, existing.nspname, existing.relname;
    execute format('drop trigger if exists %I on %I.%I', existing.tgname, existing.nspname, existing.relname);
  end loop;
end
\$register\$;
SQL

  for hook in $WEBHOOK_HOOKS; do
    table="${hook%%:*}"
    events="${hook#*:}"
    [ "$table" = "$hook" ] && fail_hard "WEBHOOK_HOOKS entry '$hook' is not <table>:<EVENT>"
    event="$(printf '%s' "$events" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')"
    trigger_name="$(printf '%s_%s_%s' "${FUNCTION_NAME//-/_}" "$table" "$(printf '%s' "$events" | tr ',' '_' | tr '[:upper:]' '[:lower:]')")"

    cat <<SQL

drop trigger if exists $trigger_name on public.$table;
create trigger $trigger_name
after $(printf '%s' "$event" | sed 's/ / or /g') on public.$table
for each row execute function supabase_functions.http_request(
  $(sql_literal "$FUNCTION_URL"),
  'POST',
  $(sql_literal "$headers_json"),
  '{}',
  '5000'
);
SQL
  done
}

# --- Run ---------------------------------------------------------------------

if [ -n "$DRY_RUN" ]; then
  AUTH_HEADER="${SUPABASE_ANON_KEY:+Bearer $SUPABASE_ANON_KEY}"
  AUTH_HEADER="${AUTH_HEADER:-Bearer <anon key>}"
  build_sql
  exit 0
fi

command -v jq >/dev/null || fail_hard "jq is required"

# Probe first: a project whose Database Webhooks were never enabled has no
# supabase_functions.http_request to hang a trigger on, and that is worth
# saying plainly instead of failing inside a DO block.
api_sql "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'supabase_functions' and p.proname = 'http_request'"
case "$api_status" in
  2*) ;;
  401|403) fail_soft "The Supabase Management API rejected SUPABASE_ACCESS_TOKEN (HTTP $api_status) — cannot register webhooks automatically." ;;
  *) fail_soft "The Supabase Management API query endpoint is unavailable (HTTP ${api_status:-no response}) — cannot register webhooks automatically." ;;
esac
if [ "$(printf '%s' "$api_body" | first_value n)" = "0" ]; then
  fail_soft "supabase_functions.http_request does not exist on this project, so Database Webhooks have never been enabled. Enable them once in the dashboard (Database -> Webhooks -> Enable), then re-run."
fi

resolve_auth_header || fail_soft "Could not resolve an Authorization header for the webhook (no SUPABASE_ANON_KEY input, no existing webhook to copy from, and the Management API did not return the anon key)."

# Hand the resolved header to later workflow steps so a probe can send
# exactly what a hook will send. It is masked either way; the anon key is
# not really a secret, but it does not belong in a log.
echo "::add-mask::$AUTH_HEADER"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'auth_header=%s\n' "$AUTH_HEADER" >> "$GITHUB_OUTPUT"
fi

sql="$(build_sql)"
api_sql "$sql"
case "$api_status" in
  2*) ;;
  *) fail_hard "Registering the webhooks failed (HTTP ${api_status:-no response}): $(printf '%s' "$api_body" | jq -r '.message? // .error? // .' 2>/dev/null | head -c 500)" ;;
esac

echo "Registered Database Webhooks for ${FUNCTION_NAME}:"
for hook in $WEBHOOK_HOOKS; do
  echo "  - public.${hook%%:*} (${hook#*:})"
done
