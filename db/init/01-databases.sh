#!/bin/bash
set -euo pipefail

# Ensures one role + one database per app, each owned by its own role.
#
# Runs in TWO situations, and is safe (idempotent) in both:
#   1. On a fresh Postgres volume, via /docker-entrypoint-initdb.d (local socket).
#   2. On every `docker compose up`, via the one-shot `db-init` service, which
#      connects over the network (PGHOST/PGPASSWORD are read from the env by psql).
# Because CREATE ROLE / CREATE DATABASE have no IF NOT EXISTS, we guard each:
# the role with a DO block, the database with psql's \gexec conditional trick.
# Re-running only creates what's missing — existing app DBs are left untouched
# (passwords are NOT reset, so changing a *_DB_PASSWORD in .env won't propagate).
#
# NOTE: pass is interpolated into a SQL string literal, so it must be a safe
# value (these come from .env as `openssl rand -hex` output). A single quote in
# the password would break the SQL; ON_ERROR_STOP=1 would then abort the run.
create_app_db() {
  local db="$1" user="$2" pass="$3"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
    DO \$\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN
        CREATE ROLE "${user}" WITH LOGIN PASSWORD '${pass}';
      END IF;
    END \$\$;
    SELECT 'CREATE DATABASE "${db}" OWNER "${user}"'
      WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\gexec
SQL
  echo "ensured database ${db} owned by ${user}"
}

create_app_db "$HUB_DB_NAME"         "$HUB_DB_USER"         "$HUB_DB_PASSWORD"
create_app_db "$WHOAMI_DB_NAME"      "$WHOAMI_DB_USER"      "$WHOAMI_DB_PASSWORD"
create_app_db "$SOCIALPOSTS_DB_NAME" "$SOCIALPOSTS_DB_USER" "$SOCIALPOSTS_DB_PASSWORD"
create_app_db "$APPROVALS_DB_NAME"   "$APPROVALS_DB_USER"   "$APPROVALS_DB_PASSWORD"
create_app_db "$MEETINGMINUTES_DB_NAME" "$MEETINGMINUTES_DB_USER" "$MEETINGMINUTES_DB_PASSWORD"
