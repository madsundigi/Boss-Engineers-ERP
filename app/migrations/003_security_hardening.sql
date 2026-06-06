-- =====================================================================
-- Platform — Security Hardening : incremental migration
-- Closes built-system QA findings on the M01/M02 sales surface:
--   PI-01  no row-level data scope        -> PostgreSQL RLS (per-company)
--   RC-01  double-convert race            -> one active quote per enquiry
--   MV-02  bu_id not scoped to company    -> composite (company_id, bu_id) FK
--   PI-02  DOA value-band not configured  -> mdm.doa_rule + seed bands
-- Idempotent. Apply AFTER 001_enquiry.sql and 002_quotation.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- a. ROW-LEVEL SECURITY (PI-01)
--    Scope every sales row to the caller's company_id, taken from the
--    transaction-local GUC `app.company_id` that the app sets via
--    set_config('app.company_id', ..., true) on each connection checkout.
--
--    ENABLE (not FORCE) is deliberate: the table owner and any superuser
--    BYPASS RLS. Enforcement therefore applies ONLY to the non-superuser
--    `erp_app` login role used in production. The test harness / migrations
--    connect as the owning superuser and must NOT be filtered, otherwise
--    seed + fixture rows would vanish mid-suite.
-- ---------------------------------------------------------------------
ALTER TABLE sales.enquiry   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.quotation ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sales.enquiry IS
  'RLS ENABLED (not FORCE): rls_enquiry_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE sales.quotation IS
  'RLS ENABLED (not FORCE): rls_quotation_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_enquiry_company ON sales.enquiry;
CREATE POLICY rls_enquiry_company ON sales.enquiry
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_quotation_company ON sales.quotation;
CREATE POLICY rls_quotation_company ON sales.quotation
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- b. DOUBLE-CONVERT GUARD (RC-01)
--    At most one *active* quotation may exist per enquiry. A partial unique
--    index excludes terminal/dead states so an enquiry can be re-quoted only
--    after the prior quote is REJECTED or LOST. Two concurrent from-enquiry
--    converts now collide on this index instead of both succeeding.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_quote_per_enquiry
  ON sales.quotation (enquiry_id)
  WHERE enquiry_id IS NOT NULL AND status NOT IN ('REJECTED','LOST');

-- ---------------------------------------------------------------------
-- c. BUSINESS-UNIT / COMPANY INTEGRITY (MV-02)
--    1) Make (company_id, bu_id) a unique key on the business_unit so it can
--       be the target of a composite FK. ADD CONSTRAINT is not idempotent,
--       so guard on pg_constraint.
--    2) Add composite FKs so a sales doc's branch must belong to its company.
--       bu_id is nullable; MATCH SIMPLE (the default) skips the check when any
--       referencing column is NULL, so lead intake without a branch still works.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_bu_company'
      AND conrelid = 'mdm.business_unit'::regclass
  ) THEN
    ALTER TABLE mdm.business_unit
      ADD CONSTRAINT uq_bu_company UNIQUE (company_id, bu_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_enquiry_bu_company'
      AND conrelid = 'sales.enquiry'::regclass
  ) THEN
    ALTER TABLE sales.enquiry
      ADD CONSTRAINT fk_enquiry_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_quotation_bu_company'
      AND conrelid = 'sales.quotation'::regclass
  ) THEN
    ALTER TABLE sales.quotation
      ADD CONSTRAINT fk_quotation_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- d. DELEGATION-OF-AUTHORITY CONFIG (PI-02)
--    A per-company value-band table the approval engine consults to pick the
--    required approver tier for a document value. Seeded with two illustrative
--    QUOTATION bands for company BE: up to 25L -> FINANCE, above -> CEO.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mdm.doa_rule (
  doa_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT REFERENCES mdm.company(company_id),
  doc_type      VARCHAR(30),
  min_value     NUMERIC(20,2),
  max_value     NUMERIC(20,2),
  approver_role VARCHAR(20),
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- One band per (company, doc_type, min_value) so the seed is re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_doa_rule_band
  ON mdm.doa_rule (company_id, doc_type, min_value);

-- Seed illustrative QUOTATION bands for company BE.
INSERT INTO mdm.doa_rule (company_id, doc_type, min_value, max_value, approver_role)
SELECT c.company_id, v.doc_type, v.min_value, v.max_value, v.approver_role
FROM mdm.company c
CROSS JOIN (VALUES
    ('QUOTATION', 0::numeric,        2500000::numeric, 'FINANCE'),
    ('QUOTATION', 2500000::numeric,  NULL::numeric,    'CEO')
  ) AS v(doc_type, min_value, max_value, approver_role)
WHERE c.company_code = 'BE'
ON CONFLICT (company_id, doc_type, min_value) DO NOTHING;

-- End migration 003_security_hardening.
