-- Restaurant Attendance Platform — initial schema
-- Conventions:
--   * Every timestamp is timestamptz (stored as UTC). Local times (shift start/end) are
--     interpreted in the branch/restaurant IANA time zone (default Asia/Kuala_Lumpur).
--   * Every tenant-owned table carries restaurant_id and is protected by row-level
--     security keyed on the per-transaction setting app.restaurant_id.
--   * attendance_events and audit_logs are append-only (see triggers at the bottom).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE restaurants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone      text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  -- Kiosk + attendance policy knobs. Validated in the API layer (see src/settings.ts).
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  address       text,
  timezone      text,           -- NULL = inherit restaurant timezone
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name),
  UNIQUE (restaurant_id, id)
);

-- ---------------------------------------------------------------------------
-- Identity (dashboard users). Not tenant-scoped: one person may belong to
-- several restaurants through memberships.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' in email) > 1),
  password_hash  text NOT NULL,
  full_name      text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  must_change_password boolean NOT NULL DEFAULT false,
  disabled       boolean NOT NULL DEFAULT false,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE member_role AS ENUM ('owner', 'manager', 'attendance_admin');

CREATE TABLE memberships (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  role           member_role NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, restaurant_id)
);
CREATE INDEX memberships_restaurant_idx ON memberships (restaurant_id);

-- Opaque session tokens; only a SHA-256 hash is stored.
CREATE TABLE user_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     bytea NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'web' CHECK (kind IN ('web', 'kiosk_manager')),
  device_id      uuid,
  user_agent     text,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
CREATE TABLE shifts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id           uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id               uuid,
  name                    text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  start_time              time NOT NULL,
  end_time                time NOT NULL,            -- end <= start means the shift crosses midnight
  days_of_week            smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}', -- ISO: 1=Mon … 7=Sun
  grace_minutes           integer NOT NULL DEFAULT 5  CHECK (grace_minutes BETWEEN 0 AND 240),
  unpaid_break_minutes    integer NOT NULL DEFAULT 0  CHECK (unpaid_break_minutes BETWEEN 0 AND 480),
  break_applies_after_minutes integer NOT NULL DEFAULT 360 CHECK (break_applies_after_minutes BETWEEN 0 AND 1440),
  overtime_after_minutes  integer CHECK (overtime_after_minutes BETWEEN 0 AND 1440), -- NULL = scheduled length
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id),
  CHECK (days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[])
);

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
CREATE TYPE employee_status AS ENUM ('active', 'suspended', 'deactivated');

CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id      uuid,
  staff_id       text NOT NULL CHECK (staff_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  full_name      text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
  preferred_name text,
  job_title      text,
  department     text,
  email          text,
  status         employee_status NOT NULL DEFAULT 'active',
  pin_hash       text,           -- non-biometric fallback (scrypt); NULL = no PIN set
  pin_failed     integer NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  UNIQUE (restaurant_id, staff_id),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id)
);
CREATE INDEX employees_restaurant_status_idx ON employees (restaurant_id, status);

-- Optional reference/profile photo (consent-gated, deletable independently).
CREATE TABLE employee_photos (
  employee_id    uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  mime           text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data           bytea NOT NULL CHECK (octet_length(data) <= 524288),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shift_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL,
  shift_id       uuid NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (restaurant_id, shift_id) REFERENCES shifts (restaurant_id, id) ON DELETE CASCADE,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX shift_assignments_employee_idx ON shift_assignments (employee_id);

-- ---------------------------------------------------------------------------
-- Kiosk devices
-- ---------------------------------------------------------------------------
CREATE TYPE device_status AS ENUM ('pending', 'active', 'revoked');

CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id           uuid,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  status              device_status NOT NULL DEFAULT 'pending',
  token_hash          bytea UNIQUE,
  pairing_code_hash   bytea UNIQUE,
  pairing_expires_at  timestamptz,
  app_version         text,
  device_model        text,
  last_seen_at        timestamptz,
  last_sync_at        timestamptz,
  pending_queue_count integer NOT NULL DEFAULT 0,
  last_error          text,
  offline_alerted_at  timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  paired_at           timestamptz,
  revoked_at          timestamptz,
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, branch_id) REFERENCES branches (restaurant_id, id)
);

-- ---------------------------------------------------------------------------
-- Biometrics. Templates are AES-256-GCM encrypted 128-d SFace embeddings.
-- Raw face images are never stored here.
-- ---------------------------------------------------------------------------
CREATE TYPE enrollment_status AS ENUM ('pending_confirmation', 'active', 'revoked', 'deleted');

CREATE TABLE face_enrollments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL,
  status              enrollment_status NOT NULL DEFAULT 'pending_confirmation',
  model               text NOT NULL,
  template_count      integer NOT NULL CHECK (template_count BETWEEN 1 AND 20),
  consent_recorded_at timestamptz NOT NULL,
  consent_method      text NOT NULL,
  consent_notice_version text NOT NULL,
  enrolled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at        timestamptz,
  device_id           uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  deleted_at          timestamptz,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
-- At most one live (pending or active) enrollment per employee.
CREATE UNIQUE INDEX face_enrollments_one_live_idx ON face_enrollments (employee_id)
  WHERE status IN ('pending_confirmation', 'active');

CREATE TABLE face_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id  uuid NOT NULL REFERENCES face_enrollments(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  key_version    smallint NOT NULL,
  iv             bytea NOT NULL,
  ciphertext     bytea NOT NULL,
  auth_tag       bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX face_templates_restaurant_idx ON face_templates (restaurant_id);

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
CREATE TYPE attendance_action AS ENUM ('check_in', 'check_out');
CREATE TYPE event_source AS ENUM ('kiosk_face', 'kiosk_pin', 'manual');
CREATE TYPE verification_status AS ENUM ('verified', 'pending_review', 'rejected');
CREATE TYPE session_status AS ENUM ('open', 'closed', 'missing_checkout', 'voided');

CREATE TABLE attendance_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id            uuid,
  employee_id          uuid NOT NULL,
  status               session_status NOT NULL DEFAULT 'open',
  check_in_event_id    uuid,
  check_out_event_id   uuid,
  check_in_at          timestamptz NOT NULL,
  check_out_at         timestamptz,
  shift_id             uuid,
  scheduled_start      timestamptz,
  scheduled_end        timestamptz,
  late_minutes         integer NOT NULL DEFAULT 0,
  is_late              boolean NOT NULL DEFAULT false,
  break_minutes        integer NOT NULL DEFAULT 0,
  worked_minutes       integer,
  overtime_minutes     integer NOT NULL DEFAULT 0,
  -- Corrections never overwrite the original times above; they are layered here.
  corrected_check_in_at  timestamptz,
  corrected_check_out_at timestamptz,
  is_corrected         boolean NOT NULL DEFAULT false,
  needs_review         boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
-- The core concurrency guarantee: an employee can have at most one open session,
-- no matter how many kiosks submit at once.
CREATE UNIQUE INDEX attendance_sessions_one_open_idx ON attendance_sessions (employee_id) WHERE status = 'open';
CREATE INDEX attendance_sessions_restaurant_time_idx ON attendance_sessions (restaurant_id, check_in_at DESC);
CREATE INDEX attendance_sessions_employee_time_idx ON attendance_sessions (employee_id, check_in_at DESC);

CREATE TABLE attendance_events (
  id                   uuid PRIMARY KEY,           -- generated by the client: idempotency key
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  branch_id            uuid,
  employee_id          uuid NOT NULL,
  event_type           attendance_action NOT NULL,
  event_time           timestamptz NOT NULL,       -- authoritative time used for calculations
  device_timestamp     timestamptz,                -- what the kiosk clock said
  server_received_at   timestamptz NOT NULL DEFAULT now(),
  device_id            uuid,
  source               event_source NOT NULL,
  verification_status  verification_status NOT NULL,
  recorded_offline     boolean NOT NULL DEFAULT false,
  match_score          real,
  liveness_passed      boolean,
  session_id           uuid,
  exception_flags      text[] NOT NULL DEFAULT '{}',
  note                 text,
  created_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at          timestamptz,
  review_note          text,
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX attendance_events_restaurant_time_idx ON attendance_events (restaurant_id, event_time DESC);
CREATE INDEX attendance_events_employee_time_idx ON attendance_events (employee_id, event_time DESC);
CREATE INDEX attendance_events_review_idx ON attendance_events (restaurant_id) WHERE verification_status = 'pending_review';

CREATE TYPE correction_status AS ENUM ('requested', 'approved', 'rejected');

CREATE TABLE attendance_corrections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id         uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  session_id            uuid,
  employee_id           uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('adjust_times', 'add_session', 'void_session')),
  original_values       jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values            jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason                text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status                correction_status NOT NULL DEFAULT 'requested',
  requested_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at            timestamptz,
  decision_note         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE
);
CREATE INDEX attendance_corrections_restaurant_idx ON attendance_corrections (restaurant_id, status);

CREATE TABLE attendance_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'late_arrival', 'missing_checkout', 'unknown_face', 'offline_conflict',
                   'clock_skew', 'device_offline', 'sync_failure', 'identity_mismatch', 'overtime')),
  severity       text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  employee_id    uuid REFERENCES employees(id) ON DELETE CASCADE,
  session_id     uuid,
  event_id       uuid,
  device_id      uuid,
  dedupe_key     text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    timestamptz,
  resolution_note text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, dedupe_key)
);
CREATE INDEX attendance_exceptions_open_idx ON attendance_exceptions (restaurant_id, created_at DESC) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notification_settings (
  restaurant_id           uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  emails                  text[] NOT NULL DEFAULT '{}',
  on_check_in             boolean NOT NULL DEFAULT true,
  on_check_out            boolean NOT NULL DEFAULT true,
  important_only          boolean NOT NULL DEFAULT false,
  late_arrival            boolean NOT NULL DEFAULT true,
  missing_checkout        boolean NOT NULL DEFAULT true,
  unknown_face            boolean NOT NULL DEFAULT true,
  suspicious_events       boolean NOT NULL DEFAULT true,
  device_offline          boolean NOT NULL DEFAULT true,
  sync_failure            boolean NOT NULL DEFAULT true,
  daily_summary           boolean NOT NULL DEFAULT true,
  daily_summary_time      time NOT NULL DEFAULT '22:00',
  quiet_hours_start       time,
  quiet_hours_end         time,
  include_staff_id        boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  dedupe_key         text NOT NULL,
  to_addresses       text[] NOT NULL,
  subject            text NOT NULL,
  text_body          text NOT NULL,
  html_body          text NOT NULL,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 8,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  not_before         timestamptz,                 -- quiet hours deferral
  last_error         text,
  provider_message_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  UNIQUE (restaurant_id, dedupe_key)
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (next_attempt_at) WHERE status IN ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'device', 'system')),
  actor_id       uuid,
  action         text NOT NULL,
  entity_type    text,
  entity_id      uuid,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_restaurant_idx ON audit_logs (restaurant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- App releases (global, not tenant-scoped)
-- ---------------------------------------------------------------------------
CREATE TABLE app_releases (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform             text NOT NULL CHECK (platform IN ('android')),
  version_code         integer NOT NULL,
  version_name         text NOT NULL,
  apk_url              text NOT NULL CHECK (apk_url LIKE 'https://%'),
  apk_sha256           text NOT NULL CHECK (apk_sha256 ~ '^[0-9a-f]{64}$'),
  signing_cert_sha256  text NOT NULL CHECK (signing_cert_sha256 ~ '^[0-9a-f]{64}$'),
  min_supported_version_code integer NOT NULL DEFAULT 1,
  release_notes        text NOT NULL DEFAULT '',
  published_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, version_code)
);

-- ---------------------------------------------------------------------------
-- Append-only guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION forbid_mutation();

-- Attendance events: the facts (who/what/when/where) are immutable. Only the review
-- fields may change, and only out of pending_review.
CREATE FUNCTION attendance_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance events cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.restaurant_id <> OLD.restaurant_id OR NEW.employee_id <> OLD.employee_id
     OR NEW.event_type <> OLD.event_type OR NEW.event_time <> OLD.event_time
     OR NEW.device_timestamp IS DISTINCT FROM OLD.device_timestamp
     OR NEW.server_received_at <> OLD.server_received_at
     OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.source <> OLD.source
     OR NEW.match_score IS DISTINCT FROM OLD.match_score THEN
    RAISE EXCEPTION 'attendance event facts are immutable; record a correction instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.verification_status <> OLD.verification_status AND OLD.verification_status <> 'pending_review' THEN
    RAISE EXCEPTION 'only pending_review events can change verification status'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER attendance_events_immutable BEFORE UPDATE OR DELETE ON attendance_events
  FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION attendance_events_guard();

-- ---------------------------------------------------------------------------
-- Realtime: every attendance-relevant change emits a NOTIFY (delivered on COMMIT).
-- ---------------------------------------------------------------------------
CREATE FUNCTION notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  r := COALESCE(NEW, OLD);
  PERFORM pg_notify('attendance_changes', json_build_object(
    'restaurant_id', r.restaurant_id, 'table', TG_TABLE_NAME, 'op', TG_OP, 'id', r.id)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER attendance_events_notify AFTER INSERT OR UPDATE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION notify_change();
CREATE TRIGGER attendance_sessions_notify AFTER INSERT OR UPDATE ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION notify_change();
CREATE TRIGGER attendance_exceptions_notify AFTER INSERT OR UPDATE ON attendance_exceptions
  FOR EACH ROW EXECUTE FUNCTION notify_change();
CREATE TRIGGER devices_notify AFTER INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION notify_change();
CREATE TRIGGER employees_notify AFTER INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION notify_change();
CREATE TRIGGER face_enrollments_notify AFTER INSERT OR UPDATE ON face_enrollments
  FOR EACH ROW EXECUTE FUNCTION notify_change();

-- ---------------------------------------------------------------------------
-- Row-level security. The application connects as a NON-owner role (APP_DB_ROLE), and
-- every tenant query runs inside a transaction that sets app.restaurant_id. The
-- migration/owner role is deliberately not subject to RLS so that the narrowly-scoped
-- SECURITY DEFINER functions below can perform pre-tenant lookups.
-- If the setting is missing, current_setting(..., true) returns NULL and no rows match.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_restaurant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'shifts', 'employees', 'employee_photos', 'shift_assignments', 'devices',
    'face_enrollments', 'face_templates', 'attendance_sessions', 'attendance_events',
    'attendance_corrections', 'attendance_exceptions', 'notification_settings',
    'notification_outbox', 'audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (restaurant_id = app_restaurant_id()) WITH CHECK (restaurant_id = app_restaurant_id())', t);
  END LOOP;
END $$;

ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON restaurants USING (id = app_restaurant_id()) WITH CHECK (id = app_restaurant_id());

-- Cross-tenant lookups needed before a tenant is known (login, token auth, background
-- workers) go through narrowly-scoped SECURITY DEFINER functions instead of bypassing RLS.
CREATE FUNCTION auth_device_by_token(p_hash bytea)
RETURNS TABLE (device_id uuid, restaurant_id uuid, branch_id uuid, status device_status, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.restaurant_id, d.branch_id, d.status, d.name FROM devices d WHERE d.token_hash = p_hash
$$;

CREATE FUNCTION auth_device_by_pairing_code(p_hash bytea)
RETURNS TABLE (device_id uuid, restaurant_id uuid, pairing_expires_at timestamptz, status device_status)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.restaurant_id, d.pairing_expires_at, d.status FROM devices d WHERE d.pairing_code_hash = p_hash
$$;

CREATE FUNCTION create_restaurant(p_name text, p_timezone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rid uuid;
BEGIN
  INSERT INTO restaurants (name, timezone) VALUES (p_name, p_timezone) RETURNING id INTO rid;
  RETURN rid;
END $$;

CREATE FUNCTION list_restaurant_ids() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM restaurants $$;

CREATE FUNCTION due_outbox_restaurants() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT restaurant_id FROM notification_outbox
  WHERE status IN ('queued', 'sending') AND next_attempt_at <= now()
$$;

CREATE FUNCTION restaurant_names_for_user(p_user uuid)
RETURNS TABLE (restaurant_id uuid, name text, role member_role)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.name, m.role FROM memberships m JOIN restaurants r ON r.id = m.restaurant_id
  WHERE m.user_id = p_user ORDER BY r.created_at
$$;
