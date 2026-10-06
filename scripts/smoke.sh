#!/usr/bin/env bash
# End-to-end check of CLI + server + Postgres against the local dev stack.
#
#   bash scripts/smoke.sh
#
# Assumes: scripts/dev-db.sh start, npm run db:migrate, npm run db:seed and a
# server on 127.0.0.1:8787 (`npm run dev`), or pass SHELF_API_URL.
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
#   setup_home <home> <machine> [scope chosen in the browser] [extra setup flags…]
setup_home() {
  local home="$1" machine="$2" scope="${3:-}"
  shift 2
  shift || true
  local log="$TMP/setup-$machine.log"
  SHELF_HOME="$home" SHELF_API_URL="$API_URL" SHELF_NO_BROWSER=1 \
    node "$CLI" setup --machine "$machine" "$@" >"$log" 2>&1 &
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
    -H "origin: $API_URL" -d "state=$state&port=$port${scope:+&scope=$scope}")"
  case "$redirect" in
    http://127.0.0.1:*) ok "browser hands the token to the loopback listener ($machine)" ;;
    *) bad "unexpected redirect ($machine): $redirect" ;;
  esac
  curl -sf "$redirect" >/dev/null || true
  wait "$pid" || bad "shelf setup exited non-zero ($machine)"
}

step "health"
expect_match "server answers /api/health" '"ok":true' curl -sf "$API_URL/api/health"

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
expect_match "reveal --print resolves the shelf's own copy" "html/$MACHINE_A/.*report.html" \
  shelf "$A" reveal report.html --print
expect_match "reveal reports a path it does not have" '"code": "not_found"' \
  shelf "$A" reveal no-such-file.html --json

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
expect_match "server lists files" 'report' curl -sf -b "$COOKIES" "$API_URL/api/files?limit=20"
FILE_ID="$(shelf "$A" list --json --search=report.html | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)"
expect_match "server serves a document" '"html"' \
  curl -sf -b "$COOKIES" "$API_URL/api/files/$FILE_ID"
expect_match "server rejects a stranger's key" '"error":"unauthorized"' \
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

step "machine rename"
printf '<!doctype html><title>Rename</title><p>still here after rename</p>' > "$TMP/rename-me.html"
expect_match "a file to rename" '"action": "created"' shelf "$A" write "$TMP/rename-me.html" --json
RENAMED="renamed-a-$$"
expect_match "rename re-files this machine's files" '"renamed": [1-9]' \
  shelf "$A" machine rename "$RENAMED" --json
expect_match "the bytes moved with the index" 'still here after rename' shelf "$A" read rename-me.html
expect_match "the new machine id is the configured one" "\"machineId\": \"$RENAMED\"" \
  shelf "$A" status --json
if [ -d "$A/html/$MACHINE_A" ]; then
  bad "the old machine folder should be gone"
else
  ok "the empty old machine folder was cleaned up"
fi
check_json "the renamed files push as new ids" 'd["pushed"] >= 1' shelf "$A" sync --json
check_json "a second sync has nothing left" 'd["pushed"] == 0' shelf "$A" sync --json --push-only

step "append-only key"
C="$TMP/home-c"
MACHINE_C="smoke-c-$$"
APPEND_URL_LOG="$TMP/setup-$MACHINE_C.log"
setup_home "$C" "$MACHINE_C" append --append-only
check_output "--append-only asks the browser for it" 'scope=append' "$(cat "$APPEND_URL_LOG")"
expect_match "config remembers the scope" '"scope": "append"' cat "$C/config.json"
C_KEY="$(sed -n 's/.*"token": "\([^"]*\)".*/\1/p' "$C/config.json")"
expect_match "/api/me reports the scope" '"scope":"append"' \
  curl -s -H "x-api-key: $C_KEY" "$API_URL/api/me"
printf '<!doctype html><title>Append</title><p>append only</p>' > "$TMP/append.html"
expect_match "an append-only key writes" '"pushed": true' shelf "$C" write "$TMP/append.html" --json
printf '<!doctype html><title>Append</title><p>append only, again</p>' > "$TMP/append.html"
expect_match "a rewrite versions instead of overwriting" 'append-v2.html' \
  shelf "$C" write "$TMP/append.html" --json
expect_match "--replace is refused locally" '"code":"append_only"' \
  shelf "$C" write "$TMP/append.html" --replace --json
C_FIRST="$(shelf "$C" list --json --search=append.html | python3 -c 'import json,sys; f=[x for x in json.load(sys.stdin)["files"] if x["path"].endswith("/append.html")][0]; print(f["id"], f["path"])')"
C_ID="${C_FIRST%% *}"
C_PATH="${C_FIRST#* }"
expect_match "the server refuses an overwrite" '"error":"exists"' \
  curl -s -H "x-api-key: $C_KEY" -H 'content-type: application/json' -X POST "$API_URL/api/files" \
  -d "{\"id\":\"$C_ID\",\"machineId\":\"$MACHINE_C\",\"path\":\"$C_PATH\",\"html\":\"<p>overwrite</p>\",\"replace\":true}"
for route in "/api/files?limit=1" "/api/files/$FILE_ID" "/api/changes" "/api/machines"; do
  expect_match "append-only cannot GET ${route%%\?*}" '"error":"forbidden_scope"' \
    curl -s -H "x-api-key: $C_KEY" "$API_URL$route"
done
expect_match "append-only cannot reach auth routes" '"error":"forbidden"' \
  curl -s -H "x-api-key: $C_KEY" "$API_URL/api/auth/api-key/list"
expect_match "append-only cannot mint a key at /cli" 'Location: .*/login' \
  curl -s -i -H "x-api-key: $C_KEY" -X POST "$API_URL/cli/authorize" -d "state=$(printf 'a%.0s' $(seq 1 32))&port=40000"
check_json "sync is push-only" 'd["pulled"] == 0 and d["scope"] == "append"' shelf "$C" sync --json
expect_match "--pull-only is refused" '"code":"append_only"' shelf "$C" sync --pull-only --json
expect_match "open is refused (headless)" '"code":"append_only"' shelf "$C" open "$TMP/append.html" --json
expect_match "status shows append only" 'append only' shelf "$C" status
expect_match "the full shelf still sees the append-only write" 'append only, again' \
  curl -sf -b "$COOKIES" "$API_URL/api/files/$(shelf "$C" list --json --search=append-v2 | sed -n 's/.*"id": "\([^"]*\)".*/\1/p' | head -1)"
expect_match "authorize page offers append only" 'Append only' \
  curl -sf -b "$COOKIES" "$API_URL/cli?port=40000&state=$(printf 'b%.0s' $(seq 1 32))&scope=append"

step "mcp"
if node "$ROOT/scripts/smoke-mcp.mjs" "$API_URL" "$EMAIL" "$PASSWORD" "$$"; then
  ok "claude.ai's OAuth flow and the list / read / write tools"
else
  bad "the MCP checks above"
fi
check_json "shelf sync pulls what MCP wrote" 'd["pulled"] >= 1' shelf "$A" sync --json --pull-only
expect_match "and it reads locally" 'three' shelf "$A" read "smoke/mcp-$$.html"

step "result"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
cat <<'NOTE'

note: this run left smoke-a-* / smoke-b-* / smoke-c-* and claude-mcp smoke/* rows in the dev database.
      clear them with:
        bash scripts/dev-db.sh psql -c "delete from shelf_files where machine_id like 'smoke-%' or (machine_id = 'claude-mcp' and path_on_machine like 'smoke/%');"
NOTE
[ "$FAIL" -eq 0 ]
