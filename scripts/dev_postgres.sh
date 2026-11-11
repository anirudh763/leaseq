#!/usr/bin/env bash
# Start (or stop) a throwaway PostgreSQL cluster for local development.
# PostgreSQL refuses to run as root, so when invoked as root this re-runs
# itself as the unprivileged "postgres" system user.
#   scripts/dev_postgres.sh start   -> prints the LEASEQ_DATABASE_URL to export
#   scripts/dev_postgres.sh stop
set -euo pipefail
PGDATA="${LEASEQ_PGDATA:-/tmp/leaseq-pgdata}"
PGPORT="${LEASEQ_PGPORT:-54329}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$BIN" ] || BIN="$(dirname "$(command -v pg_ctl)")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$PGDATA" && chown postgres "$PGDATA"
  exec su postgres -s /bin/bash -c "LEASEQ_PGDATA='$PGDATA' LEASEQ_PGPORT='$PGPORT' bash '$(readlink -f "$0")' ${1:-start}"
fi

case "${1:-start}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      "$BIN/initdb" -D "$PGDATA" -U leaseq --auth=trust -E UTF8 >/dev/null
    fi
    "$BIN/pg_ctl" -D "$PGDATA" -w -l "$PGDATA/server.log" \
      -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$PGDATA -c max_connections=100" start >/dev/null
    "$BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U leaseq leaseq 2>/dev/null || true
    echo "export LEASEQ_DATABASE_URL=postgresql://leaseq@127.0.0.1:$PGPORT/leaseq"
    ;;
  stop)
    "$BIN/pg_ctl" -D "$PGDATA" -m fast stop
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
