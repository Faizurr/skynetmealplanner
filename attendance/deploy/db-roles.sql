-- Run ONCE as an administrative user on a new database, before the first migration.
-- Creates the schema-owner role (migrations) and the runtime role (row-level security applies).
-- Replace the passwords with long random values (e.g. openssl rand -base64 24).
CREATE ROLE att_owner LOGIN PASSWORD 'REPLACE_OWNER_PASSWORD';
CREATE ROLE att_app   LOGIN PASSWORD 'REPLACE_APP_PASSWORD';
GRANT CREATE, CONNECT ON DATABASE attendance TO att_owner;   -- adjust database name
GRANT CONNECT ON DATABASE attendance TO att_app;
GRANT ALL ON SCHEMA public TO att_owner;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- may require the admin user
-- Then: MIGRATION_DATABASE_URL=...att_owner... APP_DB_ROLE=att_app npm run migrate:prod
