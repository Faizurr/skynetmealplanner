#!/usr/bin/env bash
# Creates a local development database with the same two-role setup as production.
set -euo pipefail
ADMIN=${PG_ADMIN_URL:-postgres://postgres@localhost:5432/postgres}
DB=${DB_NAME:-attendance_dev}
psql "$ADMIN" -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='att_owner') THEN CREATE ROLE att_owner LOGIN PASSWORD 'owner_pw'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='att_app') THEN CREATE ROLE att_app LOGIN PASSWORD 'app_pw'; END IF;
END \$\$;
DROP DATABASE IF EXISTS $DB WITH (FORCE);
CREATE DATABASE $DB OWNER att_owner;
SQL
psql "${ADMIN%/*}/$DB" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' >/dev/null
cd "$(dirname "$0")/../server"
MIGRATION_DATABASE_URL="postgres://att_owner:owner_pw@localhost:5432/$DB" APP_DB_ROLE=att_app npx tsx src/migrate.ts
echo "DATABASE_URL=postgres://att_app:app_pw@localhost:5432/$DB"
