-- =====================================================================
-- Enquiry — deal assignment + follow-up trail (Sales lead nurturing)
--
-- 1) sales.enquiry.assigned_to already exists (db/02) with ix_enquiry_assigned.
--    Add the FK to sec.app_user so a lead can be ASSIGNED to a salesperson.
--
-- 2) NEW sales.enquiry_followup — the sequential follow-up trail per enquiry
--    (follow-up 1..N until done). Each follow-up is either:
--      * VIRTUAL  — channel WHATSAPP | EMAIL | PHONE | VIDEO | OTHER, or
--      * PHYSICAL — a meeting at a free-text location,
--    with a scheduled date + notes; status PENDING -> DONE | CANCELLED.
--    "MISSED" is DERIVED on read (scheduled date passed while still PENDING),
--    so the dashboard alerting needs no cron.
--
-- RLS per company (erp_app only; owner/superuser bypasses, as in db/06 + 039).
-- Canonical audit trigger. erp_app gets SELECT/INSERT/UPDATE (soft-delete only).
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) + migration 039.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. FK on the existing assigned_to column (column + index already exist).
--    Guarded via pg_constraint so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_enquiry_assigned_to' AND conrelid = 'sales.enquiry'::regclass
  ) THEN
    ALTER TABLE sales.enquiry
      ADD CONSTRAINT fk_enquiry_assigned_to
      FOREIGN KEY (assigned_to) REFERENCES sec.app_user(user_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. The follow-up trail. bigint-identity PK + the canonical audit/concurrency
--    columns. uq (enquiry_id, seq) keeps the follow-up number unique per lead.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.enquiry_followup (
    followup_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_id          BIGINT REFERENCES mdm.business_unit(bu_id),
    enquiry_id     BIGINT NOT NULL REFERENCES sales.enquiry(enquiry_id),
    seq            INT NOT NULL,                       -- 1,2,3... per enquiry
    followup_type  VARCHAR(10) NOT NULL,               -- VIRTUAL | PHYSICAL
    channel        VARCHAR(15),                        -- virtual: WHATSAPP|EMAIL|PHONE|VIDEO|OTHER
    channel_other  VARCHAR(60),                        -- free-text when channel = OTHER
    location       VARCHAR(300),                       -- physical: where to meet
    scheduled_date DATE NOT NULL,                      -- when the follow-up is due
    notes          TEXT,
    status         VARCHAR(12) NOT NULL DEFAULT 'PENDING',  -- PENDING | DONE | CANCELLED (MISSED is derived)
    outcome        TEXT,                               -- what happened, captured on completion
    assigned_to    BIGINT REFERENCES sec.app_user(user_id), -- owner (defaults to enquiry.assigned_to)
    completed_at   TIMESTAMPTZ,
    completed_by   BIGINT REFERENCES sec.app_user(user_id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     BIGINT REFERENCES sec.app_user(user_id),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by     BIGINT REFERENCES sec.app_user(user_id),
    row_version    INT NOT NULL DEFAULT 1,
    is_deleted     BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_enquiry_followup_seq UNIQUE (enquiry_id, seq),
    CONSTRAINT ck_enquiry_followup_type CHECK (followup_type IN ('VIRTUAL','PHYSICAL')),
    CONSTRAINT ck_enquiry_followup_channel
      CHECK (channel IS NULL OR channel IN ('WHATSAPP','EMAIL','PHONE','VIDEO','OTHER')),
    CONSTRAINT ck_enquiry_followup_status CHECK (status IN ('PENDING','DONE','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS ix_enquiry_followup_company_status
  ON sales.enquiry_followup(company_id, status);
CREATE INDEX IF NOT EXISTS ix_enquiry_followup_enquiry
  ON sales.enquiry_followup(enquiry_id);
CREATE INDEX IF NOT EXISTS ix_enquiry_followup_scheduled
  ON sales.enquiry_followup(scheduled_date);
CREATE INDEX IF NOT EXISTS ix_enquiry_followup_assigned
  ON sales.enquiry_followup(assigned_to);

-- ---------------------------------------------------------------------
-- 3. ROW-LEVEL SECURITY (per company). ENABLE (not FORCE): owner/superuser
--    bypasses (migrations + tests); only erp_app is scoped.
-- ---------------------------------------------------------------------
ALTER TABLE sales.enquiry_followup ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE sales.enquiry_followup IS
  'RLS ENABLED (not FORCE): rls_enquiry_followup_company scopes rows to app.company_id for the erp_app role only; owner/superuser bypasses (tests + migrations). Sequential follow-up trail per enquiry (VIRTUAL channel / PHYSICAL location); PENDING -> DONE | CANCELLED; MISSED is derived on read when a PENDING follow-up''s scheduled_date has passed.';

DROP POLICY IF EXISTS rls_enquiry_followup_company ON sales.enquiry_followup;
CREATE POLICY rls_enquiry_followup_company ON sales.enquiry_followup
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 4. BUSINESS-UNIT / COMPANY INTEGRITY: the follow-up's branch must belong to
--    its company. bu_id nullable; MATCH SIMPLE skips the check when NULL.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_enquiry_followup_bu_company'
      AND conrelid = 'sales.enquiry_followup'::regclass
  ) THEN
    ALTER TABLE sales.enquiry_followup
      ADD CONSTRAINT fk_enquiry_followup_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. AUDIT TRIGGER (new table; db/06 attaches none). Guarded on pg_trigger.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_enquiry_followup'
      AND tgrelid = 'sales.enquiry_followup'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_enquiry_followup
      AFTER INSERT OR UPDATE OR DELETE ON sales.enquiry_followup
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('followup_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. Grants. erp_app: SELECT/INSERT/UPDATE (soft-delete only — no DELETE).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON sales.enquiry_followup TO erp_app;

-- End migration 054_enquiry_followup.
