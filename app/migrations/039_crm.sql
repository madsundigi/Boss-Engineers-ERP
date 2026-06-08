-- =====================================================================
-- Module — CRM (FRD §11 Tier-2: beyond enquiry) : new module
-- The Enquiry module captures raw leads; CRM takes the qualified ones forward as a
-- sales OPPORTUNITY through a pipeline (NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION
-- -> WON | LOST), with ACTIVITIES (calls / meetings / emails / tasks / notes) as the
-- follow-up trail and a customer-360 read. There is NO base table for any of it, so
-- this migration CREATES a NEW schema + two tables:
--   crm.opportunity  (header)  — one sales opportunity per qualified pursuit
--   crm.activity     (sibling) — a follow-up activity, linked to an opp and/or customer
--
-- It seeds the 'CRM' RBAC domain (absent from db/08) + the 'OPPORTUNITY' numbering
-- rule (prefix 'OPP', absent from db/07), enables per-company Row-Level Security on
-- both tables, adds the composite (company_id, bu_id) FK on the opportunity, attaches
-- the canonical audit trigger (db/06 has none for these new tables), and grants
-- erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 038.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SCHEMA. CRM gets its own namespace. GRANT USAGE so the RLS-enforced erp_app
--    role can reach the objects (table grants below add the DML).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS crm;
GRANT USAGE ON SCHEMA crm TO erp_app;

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'CRM' permission domain (db/08 has no such module) and grant
--    it to roles. SALES owns the pipeline (VCEDA); ADMIN holds all six (VCEDAX);
--    CEO views + approves + exports (VAX); PLANNING/FINANCE read (V). perm_code is
--    'CRM.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'CRM.'||a,'CRM',a,a||' on CRM' FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES ('SALES','VCEDA'),('ADMIN','VCEDAX'),('CEO','VAX'),('PLANNING','V'),('FINANCE','V')) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action) ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='CRM' AND p.action=f.action ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLES. The opportunity header + its follow-up activities. bigint-identity PKs
--    + the canonical audit/concurrency columns (mirrors the db/05 / 029 idioms).
--    opp_no is the document number; the unique (company_id, opp_no) keeps it unique
--    within a tenant. est_value is NUMERIC(20,4); probability_pct NUMERIC(9,4). The
--    activity links to an opportunity and/or a customer (both nullable).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm.opportunity (
    opp_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id          BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_id               BIGINT REFERENCES mdm.business_unit(bu_id),
    opp_no              VARCHAR(30) NOT NULL,
    customer_id         BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    enquiry_id          BIGINT REFERENCES sales.enquiry(enquiry_id),
    title               VARCHAR(200) NOT NULL,
    stage               VARCHAR(15) NOT NULL DEFAULT 'NEW',
    est_value           NUMERIC(20,4) NOT NULL DEFAULT 0,
    probability_pct     NUMERIC(9,4) NOT NULL DEFAULT 0,
    expected_close_date DATE,
    owner_id            BIGINT REFERENCES sec.app_user(user_id),
    lost_reason         VARCHAR(300),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          BIGINT REFERENCES sec.app_user(user_id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          BIGINT REFERENCES sec.app_user(user_id),
    row_version         INT NOT NULL DEFAULT 1,
    is_deleted          BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_crm_opportunity_no UNIQUE (company_id, opp_no),
    CONSTRAINT ck_crm_opportunity_stage CHECK (stage IN ('NEW','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'))
);

CREATE TABLE IF NOT EXISTS crm.activity (
    activity_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    opp_id        BIGINT REFERENCES crm.opportunity(opp_id),
    customer_id   BIGINT REFERENCES mdm.customer(customer_id),
    activity_type VARCHAR(12) NOT NULL,
    subject       VARCHAR(200) NOT NULL,
    due_date      DATE,
    completed_at  TIMESTAMPTZ,
    status        VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    owner_id      BIGINT REFERENCES sec.app_user(user_id),
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    BIGINT REFERENCES sec.app_user(user_id),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    BIGINT REFERENCES sec.app_user(user_id),
    row_version   INT NOT NULL DEFAULT 1,
    is_deleted    BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_crm_activity_type CHECK (activity_type IN ('CALL','MEETING','EMAIL','TASK','NOTE')),
    CONSTRAINT ck_crm_activity_status CHECK (status IN ('PENDING','DONE','CANCELLED'))
);

-- ---------------------------------------------------------------------
-- 3. Numbering rule for 'OPPORTUNITY' — branch-scoped, prefix 'OPP', FY reset. Not
--    in the db/07 seed, so add one rule per BE branch. Mirrors the db/07 / 029
--    pattern; guarded so re-runs are no-ops. mdm.next_document_no(company,bu,
--    'OPPORTUNITY') yields e.g. OPP/MUM/2026-27/000001.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'OPPORTUNITY', 'OPP', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Helpful indexes for the List screen filters + the pipeline / activity reads.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_crm_opportunity_company_stage
  ON crm.opportunity(company_id, stage);
CREATE INDEX IF NOT EXISTS ix_crm_opportunity_customer
  ON crm.opportunity(customer_id);
CREATE INDEX IF NOT EXISTS ix_crm_activity_company_status
  ON crm.activity(company_id, status);
CREATE INDEX IF NOT EXISTS ix_crm_activity_opp
  ON crm.activity(opp_id);
CREATE INDEX IF NOT EXISTS ix_crm_activity_customer
  ON crm.activity(customer_id);

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (per-company) on BOTH tables. ENABLE (not FORCE): the table
--    owner / superuser BYPASSES RLS, so migrations + the test harness are not
--    filtered; enforcement applies ONLY to the non-superuser erp_app login role.
--    Unlike the contract milestone child (reached only via its parent), an activity
--    is queried directly (list / customer-360), so it carries company_id + a policy.
-- ---------------------------------------------------------------------
ALTER TABLE crm.opportunity ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.activity    ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE crm.opportunity IS
  'RLS ENABLED (not FORCE): rls_crm_opp_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Sales opportunity pipeline: NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION -> WON | LOST.';
COMMENT ON TABLE crm.activity IS
  'RLS ENABLED (not FORCE): rls_crm_activity_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). CRM follow-up activity (CALL/MEETING/EMAIL/TASK/NOTE), linked to an opportunity and/or customer.';

DROP POLICY IF EXISTS rls_crm_opp_company ON crm.opportunity;
CREATE POLICY rls_crm_opp_company ON crm.opportunity
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_crm_activity_company ON crm.activity;
CREATE POLICY rls_crm_activity_company ON crm.activity
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 6. BUSINESS-UNIT / COMPANY INTEGRITY: an opportunity's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) opportunity still works. uq_bu_company exists from
--    003. Guarded via pg_constraint so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_crm_opp_bu_company'
      AND conrelid = 'crm.opportunity'::regclass
  ) THEN
    ALTER TABLE crm.opportunity
      ADD CONSTRAINT fk_crm_opp_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGERS. These tables are new (db/06 attaches trg_audit_* only to the
--    pre-existing high-value documents), so add the canonical audit.fn_audit on
--    each (keyed on its pk) so every CREATE/EDIT/DELETE is attributed. Guarded on
--    pg_trigger so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_crm_opportunity'
      AND tgrelid = 'crm.opportunity'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_crm_opportunity
      AFTER INSERT OR UPDATE OR DELETE ON crm.opportunity
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('opp_id');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_crm_activity'
      AND tgrelid = 'crm.activity'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_crm_activity
      AFTER INSERT OR UPDATE OR DELETE ON crm.activity
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('activity_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Grants. erp_app needs SELECT/INSERT/UPDATE on both tables (both are
--    soft-delete only — no DELETE).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    crm.opportunity,
    crm.activity
TO erp_app;

-- End migration 039_crm.
