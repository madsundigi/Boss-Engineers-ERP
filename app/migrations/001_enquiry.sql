-- =====================================================================
-- Module M01 — Customer Enquiry : incremental migration
-- Extends the base sales.enquiry (db/02) with intake-capture fields so a
-- raw lead can be recorded before a customer master record exists.
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql).
-- =====================================================================

-- 1. Intake-capture columns (denormalized snapshot of the lead)
ALTER TABLE sales.enquiry
  ADD COLUMN IF NOT EXISTS bu_id          BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS customer_name  VARCHAR(160),
  ADD COLUMN IF NOT EXISTS contact_person VARCHAR(120),
  ADD COLUMN IF NOT EXISTS email          VARCHAR(160),
  ADD COLUMN IF NOT EXISTS address        TEXT,
  ADD COLUMN IF NOT EXISTS industry       VARCHAR(80),
  ADD COLUMN IF NOT EXISTS requirement    TEXT;

-- 2. A new enquiry is a pre-customer lead: customer_id becomes optional
ALTER TABLE sales.enquiry ALTER COLUMN customer_id DROP NOT NULL;

-- 3. Require a captured customer name (the intake identity)
UPDATE sales.enquiry SET customer_name = 'UNKNOWN' WHERE customer_name IS NULL;
ALTER TABLE sales.enquiry ALTER COLUMN customer_name SET NOT NULL;

-- 4. Widen the Source domain (keep base values, add common ERP sources)
ALTER TABLE sales.enquiry DROP CONSTRAINT IF EXISTS ck_enq_source;
ALTER TABLE sales.enquiry ADD CONSTRAINT ck_enq_source
  CHECK (source IS NULL OR source IN
    ('EMAIL','WEB','PHONE','WALKIN','REP','REFERRAL','EXHIBITION','OTHER'));

-- 5. Unify the lifecycle on a single user-facing Status
ALTER TABLE sales.enquiry ALTER COLUMN status SET DEFAULT 'NEW';
ALTER TABLE sales.enquiry DROP CONSTRAINT IF EXISTS ck_enq_status;
ALTER TABLE sales.enquiry ADD CONSTRAINT ck_enq_status
  CHECK (status IN ('NEW','QUALIFIED','QUOTED','CONVERTED','LOST','ON_HOLD'));

-- 6. Defense-in-depth: email format guard at the DB layer (app validates too)
ALTER TABLE sales.enquiry DROP CONSTRAINT IF EXISTS ck_enq_email;
ALTER TABLE sales.enquiry ADD CONSTRAINT ck_enq_email
  CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- 7. Helpful indexes for the List screen filters
CREATE INDEX IF NOT EXISTS ix_enquiry_company_status ON sales.enquiry(company_id, status);
CREATE INDEX IF NOT EXISTS ix_enquiry_email          ON sales.enquiry(lower(email));

-- 8. Wire audit + status-history triggers (reuse base functions)
DROP TRIGGER IF EXISTS trg_enquiry_audit ON sales.enquiry;
CREATE TRIGGER trg_enquiry_audit
  AFTER INSERT OR UPDATE OR DELETE ON sales.enquiry
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('enquiry_id');

DROP TRIGGER IF EXISTS trg_enquiry_status_hist ON sales.enquiry;
CREATE TRIGGER trg_enquiry_status_hist
  AFTER INSERT OR UPDATE OF status ON sales.enquiry
  FOR EACH ROW EXECUTE FUNCTION audit.fn_status_history('ENQUIRY','enquiry_id');

-- End migration 001_enquiry.
