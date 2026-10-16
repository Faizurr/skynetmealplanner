-- Payroll: per-employee daily salary (for a standard 12-hour day), one payout per completed
-- attendance session, and proof-of-payment photos. Money is stored in integer sen (cents).

CREATE TABLE employee_pay_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL,
  daily_rate_cents   integer NOT NULL CHECK (daily_rate_cents BETWEEN 0 AND 100000000),
  effective_from     date NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  UNIQUE (employee_id, effective_from)
);
CREATE INDEX employee_pay_rates_lookup_idx ON employee_pay_rates (employee_id, effective_from DESC);

CREATE TYPE payout_status AS ENUM ('pending', 'paid', 'void');
CREATE TYPE payout_method AS ENUM ('cash', 'qr');

CREATE TABLE payouts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL,
  session_id         uuid NOT NULL UNIQUE,     -- one payout per worked session (idempotent)
  work_date          date NOT NULL,            -- local date of the check-in
  check_in_at        timestamptz NOT NULL,
  check_out_at       timestamptz NOT NULL,
  worked_minutes     integer NOT NULL CHECK (worked_minutes >= 0),
  standard_minutes   integer NOT NULL CHECK (standard_minutes > 0),
  ot_minutes         integer NOT NULL DEFAULT 0 CHECK (ot_minutes >= 0),
  daily_rate_cents   integer NOT NULL DEFAULT 0,
  base_cents         integer NOT NULL DEFAULT 0,
  ot_cents           integer NOT NULL DEFAULT 0,
  adjustment_cents   integer NOT NULL DEFAULT 0,
  total_cents        integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  adjustment_reason  text,
  rate_missing       boolean NOT NULL DEFAULT false,
  needs_review       boolean NOT NULL DEFAULT false,
  review_reason      text,
  status             payout_status NOT NULL DEFAULT 'pending',
  method             payout_method,
  pay_note           text,
  paid_at            timestamptz,
  paid_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, employee_id) REFERENCES employees (restaurant_id, id) ON DELETE CASCADE,
  CHECK (status <> 'paid' OR (method IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX payouts_status_idx ON payouts (restaurant_id, status, work_date DESC);
CREATE INDEX payouts_employee_idx ON payouts (employee_id, work_date DESC);

CREATE TABLE payout_proofs (
  payout_id           uuid PRIMARY KEY REFERENCES payouts(id) ON DELETE CASCADE,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  mime                text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data                bytea NOT NULL CHECK (octet_length(data) <= 4194304),
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- A paid payout's money fields are frozen; it must be reopened (audited) before they change.
CREATE FUNCTION payouts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' AND NEW.status = 'paid' AND (
       NEW.total_cents <> OLD.total_cents OR NEW.base_cents <> OLD.base_cents OR NEW.ot_cents <> OLD.ot_cents
       OR NEW.adjustment_cents <> OLD.adjustment_cents OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
    RAISE EXCEPTION 'paid payouts cannot be changed; reopen it first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payouts_frozen_when_paid BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION payouts_guard();

CREATE TRIGGER payouts_notify AFTER INSERT OR UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION notify_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee_pay_rates', 'payouts', 'payout_proofs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (restaurant_id = app_restaurant_id()) WITH CHECK (restaurant_id = app_restaurant_id())', t);
  END LOOP;
END $$;
