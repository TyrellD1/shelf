#!/usr/bin/env bash
# Self-contained local Postgres for Shelf development.
#
# Uses the system Postgres binaries against a private data directory so it never
# touches any other database on the machine. The same server backs local dev and
# (via any Postgres URL) production parity.
#
#   scripts/dev-db.sh start|stop|status|url|psql
set -euo pipefail

SHELF_HOME_DIR="${SHELF_DEV_HOME:-$HOME/.shelf-dev}"
PGDATA="${SHELF_PGDATA:-$SHELF_HOME_DIR/pgdata}"
PGPORT="${SHELF_PGPORT:-55432}"
PGUSER_NAME="${SHELF_PGUSER:-shelf}"
PGDATABASE="${SHELF_PGDATABASE:-shelf}"
LOGFILE="$PGDATA/server.log"

export PATH="/opt/homebrew/opt/postgresql@18/bin:/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/opt/postgresql@15/bin:/opt/homebrew/opt/postgresql@14/bin:/usr/local/opt/postgresql@14/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "shelf: missing '$1'. Install Postgres (brew install postgresql@16) or use Docker:" >&2
    echo "       docker compose up -d" >&2
    exit 1
  fi
}

is_running() {
  [ -f "$PGDATA/postmaster.pid" ] && pg_ctl -D "$PGDATA" status >/dev/null 2>&1
}

url() {
  echo "postgres://$PGUSER_NAME@127.0.0.1:$PGPORT/$PGDATABASE"
}

case "${1:-start}" in
  start)
    require initdb
    if [ ! -d "$PGDATA" ]; then
      echo "shelf: initializing $PGDATA" >&2
      mkdir -p "$PGDATA"
      initdb -D "$PGDATA" -U "$PGUSER_NAME" --auth=trust --encoding=UTF8 >/dev/null
    fi
    if is_running; then
      echo "shelf: postgres already running on port $PGPORT"
    else
      # macOS: a valid LC_ALL keeps the postmaster single-threaded at startup.
      LC_ALL="en_US.UTF-8" LANG="en_US.UTF-8" pg_ctl -D "$PGDATA" -l "$LOGFILE" \
        -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
      echo "shelf: postgres started on port $PGPORT"
    fi
    if ! psql -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_NAME" -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDATABASE"; then
      createdb -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER_NAME" "$PGDATABASE"
      echo "shelf: created database $PGDATABASE"
    fi
    url
    ;;
  stop)
    if is_running; then
      pg_ctl -D "$PGDATA" -w stop >/dev/null
      echo "shelf: postgres stopped"
    else
      echo "shelf: postgres not running"
    fi
    ;;
  status)
    if is_running; then
      echo "shelf: postgres running on port $PGPORT ($PGDATA)"
      url
    else
      echo "shelf: postgres not running"
      exit 1
    fi
    ;;
  url)
    url
    ;;
  psql)
    shift || true
    psql "$(url)" "$@"
    ;;
  *)
    echo "usage: scripts/dev-db.sh start|stop|status|url|psql" >&2
    exit 2
    ;;
esac
