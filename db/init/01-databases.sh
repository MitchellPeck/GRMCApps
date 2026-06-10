#!/bin/bash
set -euo pipefail

# Runs once on first container start, as the superuser, against the default DB.
# Creates one role + one database per app, each owned by its own role.
# NOTE: pass is interpolated into a SQL string literal, so it must be a safe
# value (these come from .env as `openssl rand -hex` output). A single quote in
# the password would break the SQL; ON_ERROR_STOP=1 would then abort the run.
create_app_db() {
  local db="$1" user="$2" pass="$3"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
    CREATE ROLE "${user}" WITH LOGIN PASSWORD '${pass}';
    CREATE DATABASE "${db}" OWNER "${user}";
SQL
  echo "created database ${db} owned by ${user}"
}

create_app_db "$HUB_DB_NAME"         "$HUB_DB_USER"         "$HUB_DB_PASSWORD"
create_app_db "$WHOAMI_DB_NAME"      "$WHOAMI_DB_USER"      "$WHOAMI_DB_PASSWORD"
create_app_db "$SOCIALPOSTS_DB_NAME" "$SOCIALPOSTS_DB_USER" "$SOCIALPOSTS_DB_PASSWORD"
