#!/usr/bin/env bash
# Everything needed for a local run: Postgres, schema, seed account, worker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT/web/.dev.vars" ]; then
  echo "web/.dev.vars is missing. Run:" >&2
  echo "  cp web/.dev.vars.example web/.dev.vars   # then fill it in" >&2
  exit 1
fi

bash "$ROOT/scripts/dev-db.sh" start
npm --prefix "$ROOT" run db:migrate
npm --prefix "$ROOT" run db:seed
npm --prefix "$ROOT" run build -w ui

echo
echo "worker:   http://localhost:8787"
echo "cli:      npm run install:cli && shelf setup --api http://localhost:8787"
echo
exec npm --prefix "$ROOT" run dev
