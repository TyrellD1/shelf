#!/usr/bin/env bash
# End-to-end check of CLI + worker + Postgres against the local dev stack.
#
#   bash scripts/smoke.sh
#
# Assumes: scripts/dev-db.sh start, npm run db:migrate, npm run db:seed and a
# worker on 127.0.0.1:8787 (`npm run dev`), or pass SHELF_API_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${SHELF_API_URL:-http://localhost:8787}"
CLI="$ROOT/cli/dist/shelf.cjs"
EMAIL="${SHELF_SEED_EMAIL:-}"
PASSWORD="${SHELF_SEED_PASSWORD:-}"

if [ -f "$ROOT/web/.dev.vars" ]; then
  [ -n "$EMAIL" ] || EMAIL="$(grep -E '^SEED_EMAIL=' "$ROOT/web/.dev.vars" | cut -d= -f2-)"
  [ -n "$PASSWORD" ] || PASSWORD="$(grep -E '^SEED_PASSWORD=' "$ROOT/web/.dev.vars" | cut -d= -f2-)"
fi

TMP="$(mktemp -d)"
COOKIES="$TMP/cookies.txt"
# Unique per run so repeated runs stay independent on a shared database.
MACHINE_A="smoke-a-$$"
MACHINE_B="smoke-b-$$"
PASS=0
FAIL=0

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

shelf() { SHELF_HOME="$1" SHELF_API_URL="$API_URL" node "$CLI" "${@:2}"; }

expect_match() {
  local desc="$1" needle="$2"
  shift 2
  local out
  out="$("$@" 2>&1)" || true
  if printf '%s' "$out" | grep -q "$needle"; then
    ok "$desc"
  else
    bad "$desc"
    printf '      expected /%s/, got: %s\n' "$needle" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-700)"
  fi
}

expect_file() {
  if [ -f "$1" ]; then ok "$2"; else bad "$2"; fi
}

# Asserts on parsed JSON output: check_json "<desc>" '<python expr over d>' cmd...
check_json() {
  local desc="$1" expr="$2"
  shift 2
  local out
  out="$("$@" 2>/dev/null)" || true
  if printf '%s' "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if ($expr) else 1)" 2>/dev/null; then
    ok "$desc"
  else
    bad "$desc"
    printf '      got: %s\n' "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

# For one command whose output must satisfy several assertions.
check_output() {
  local desc="$1" needle="$2" out="$3"
  if printf '%s' "$out" | grep -q "$needle"; then
    ok "$desc"
  else
    bad "$desc"
    printf '      expected /%s/, got: %s\n' "$needle" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  fi
}

# Drives the browser half of `shelf setup` over HTTP with the session cookie.
setup_home() {
  local home="$1" machine="$2"
  local log="$TMP/setup-$machine.log"
  SHELF_HOME="$home" SHELF_API_URL="$API_URL" SHELF_NO_BROWSER=1 \
    node "$CLI" setup --machine "$machine" >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 100); do
    grep -q '/cli?port=' "$log" 2>/dev/null && break
    sleep 0.2
  done
  local auth_url port state redirect
  auth_url="$(grep -o "${API_URL}/cli?[^ ]*" "$log" | head -1 || true)"
  if [ -z "$auth_url" ]; then
    bad "setup printed an authorization URL ($machine)"
    cat "$log"
    kill "$pid" 2>/dev/null || true
    return 1
  fi
  port="$(printf '%s' "$auth_url" | sed -n 's/.*port=\([0-9]*\).*/\1/p')"
  state="$(printf '%s' "$auth_url" | sed -n 's/.*state=\([a-f0-9]*\).*/\1/p')"
  expect_match "authorize page renders ($machine)" 'Authorize' curl -sf -b "$COOKIES" "$auth_url"
  redirect="$(curl -s -o /dev/null -w '%{redirect_url}' -b "$COOKIES" -X POST "$API_URL/cli/authorize" \
    -H "origin: $API_URL" -d "state=$state&port=$port")"
  case "$redirect" in
    http://127.0.0.1:*) ok "browser hands the token to the loopback listener ($machine)" ;;
    *) bad "unexpected redirect ($machine): $redirect" ;;
  esac
  curl -sf "$redirect" >/dev/null || true
  wait "$pid" || bad "shelf setup exited non-zero ($machine)"
}

step "health"
expect_match "worker answers /api/health" '"ok":true' curl -sf "$API_URL/api/health"

step "browser session"
curl -sf -c "$COOKIES" -X POST "$API_URL/api/auth/sign-in/email" \
  -H 'content-type: application/json' -H "origin: $API_URL" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
ok "signed in as $EMAIL"
expect_match "session cookie works" '"fileCount"' curl -sf -b "$COOKIES" "$API_URL/api/me"

step "setup: browser handoff"
A="$TMP/home-a"
B="$TMP/home-b"
setup_home "$A" "$MACHINE_A"
setup_home "$B" "$MACHINE_B"
expect_file "$A/config.json" "config.json written"
expect_match "machine id stored" "\"machineId\": \"$MACHINE_A\"" cat "$A/config.json"

step "write / list / read"
printf '<!doctype html><title>Smoke</title><h1>hello shelf</h1>' > "$TMP/report.html"
expect_match "write pushes" '"pushed": true' shelf "$A" write "$TMP/report.html" --json
expect_match "list shows the file" 'report.html' shelf "$A" list --json
expect_match "read returns the html" 'hello shelf' shelf "$A" read report.html

step "immutable paths"
printf '<!doctype html><title>Smoke</title><h1>second</h1>' > "$TMP/report.html"
expect_match "rewrite versions to report-v2.html" 'report-v2.html' \
  shelf "$A" write "$TMP/report.html" --json
expect_match "same content is a no-op" '"action": "unchanged"' shelf "$A" write "$TMP/report.html" --json
expect_match "--replace updates in place" '"action": "replaced"' \
  shelf "$A" write "$TMP/report.html" --replace --json
printf '<!doctype html><title>Smoke</title><h1>third</h1>' > "$TMP/report.html"
NEW_PATH="$(shelf "$A" write "$TMP/report.html" --json | sed -n 's/.*"path": "\([^"]*\)".*/\1/p')"
case "$NEW_PATH" in
  *-v[0-9]*.html) ok "a later edit gets a fresh version path ($(basename "$NEW_PATH"))" ;;
  *) bad "expected a versioned path, got '$NEW_PATH'" ;;
esac

step "sync between machines"
printf '<!doctype html><title>From B</title><p>written on b</p>' > "$TMP/from-b.html"
expect_match "machine B pushes" '"pushed": true' shelf "$B" write "$TMP/from-b.html" --json
check_json "machine A pulls what B wrote" 'd["pulled"] >= 1 and d["ok"] is True' shelf "$A" sync --json
B_PATH="$(shelf "$A" list --json --search=from-b.html | sed -n 's/.*"path": "\([^"]*\)".*/\1/p' | head -1)"
expect_match "A can read B's file by path" 'written on b' shelf "$A" read "$B_PATH"
B_ID="$(shelf "$A" list --json --search=from-b.html | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)"
expect_match "A can read B's file by id" 'written on b' shelf "$A" read "$B_ID"
expect_match "A's list shows both machines" "$MACHINE_B" shelf "$A" list --json
if find "$A/html/$MACHINE_B" -name 'from-b.html' | grep -q .; then
  ok "B's bytes landed in A's local store"
else
  bad "B's bytes landed in A's local store"
fi

step "web app sees everything"
expect_match "worker lists files" 'report' curl -sf -b "$COOKIES" "$API_URL/api/files?limit=20"
FILE_ID="$(shelf "$A" list --json --search=report.html | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)"
expect_match "worker serves a document" '"html"' \
  curl -sf -b "$COOKIES" "$API_URL/api/files/$FILE_ID"
expect_match "worker rejects a stranger's key" '"error":"unauthorized"' \
  curl -s -H 'x-api-key: not-a-real-key' "$API_URL/api/files/$FILE_ID"
expect_match "changes feed works" 'nextSince' \
  curl -sf -b "$COOKIES" "$API_URL/api/changes?since=1970-01-01T00:00:00.000Z"
expect_match "unauthorized without a key or cookie" '"error":"unauthorized"' \
  curl -s "$API_URL/api/files?limit=1"

step "status"
expect_match "status reports configured" '"configured": true' shelf "$A" status --json
expect_match "status knows both machines" "$MACHINE_B" shelf "$A" status --json

step "a lost index is recoverable"
printf '<!doctype html><title>Rebuild</title><p>rebuild check</p>' > "$TMP/rebuild.html"
UNIQUE="$(basename "$TMP")/rebuild.html"
expect_match "fresh file writes" '"action": "created"' shelf "$A" write "$TMP/rebuild.html" --json
mv "$A/index.json" "$A/index.json.lost"
expect_match "list rebuilds metadata from the store" "$UNIQUE" shelf "$A" list --json --search="$UNIQUE"
REBUILT="$(shelf "$A" write "$TMP/rebuild.html" --json 2>&1 || true)"
check_output "identical bytes stay a no-op after a rebuild" '"action": "unchanged"' "$REBUILT"
check_output "the no-op repushes what the rebuild could not know" '"pushed": true' "$REBUILT"
expect_match "no second copy of that path was written" '"total": 1' \
  shelf "$A" list --json --search="$UNIQUE"
expect_match "sync finishes after a rebuild" '"ok": true' shelf "$A" sync --json --push-only
expect_match "a second sync has nothing left to push" '"pushed": 0' shelf "$A" sync --json --push-only

step "result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
cat <<'NOTE'

note: this run left smoke-a-* / smoke-b-* rows in the dev database.
      clear them with:
        bash scripts/dev-db.sh psql -c "delete from shelf_files where machine_id like 'smoke-%';"
NOTE
[ "$FAIL" -eq 0 ]
