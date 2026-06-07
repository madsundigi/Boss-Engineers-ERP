-- =====================================================================
-- Module — Contract Management (Tier-2 gap) : incremental migration
-- The COMMERCIAL customer contract: the binding agreement that fixes the contract
-- value, payment terms, LD / penalty and warranty obligations, and the billing-
-- milestone schedule for a project. There is NO base table for it (the base model
-- has proj.project + svc.service_contract, but the latter is the AMC / service
-- contract owned by the Service module), so this migration CREATES the two tables:
--   sales.customer_contract  (header)   — one binding contract per customer/project
--   sales.contract_milestone (children) — its billing-milestone schedule
--
-- It seeds the 'CONTRACT' RBAC domain (absent from db/08) + the 'CONTRACT'
-- numbering rule (prefix 'CON', absent from db/07), enables per-company Row-Level
-- Security on the header, adds the composite (company_id, bu_id) FK, attaches the
-- canonical audit trigger (db/06 has none for these new tables), and grants
-- erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 028.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'CONTRACT' permission domain (db/08 has no such module)
--    and grant it to roles. SALES owns the document (VCE), FINANCE adds the
--    activate/approve gate (VCEA), CEO views + activates + exports (VAX), ADMIN
--    holds all six (VCEDAX), PLANNING/PRODUCTION read (V). perm_code is
--    'CONTRACT.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'CONTRACT.'||a,'CONTRACT',a,a||' on CONTRACT' FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES ('SALES','VCE'),('FINANCE','VCEA'),('CEO','VAX'),('ADMIN','VCEDAX'),('PLANNING','V'),('PRODUCTION','V')) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action) ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='CONTRACT' AND p.action=f.action ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLES. The commercial customer contract header + its billing-milestone
--    schedule. bigint-identity PKs + the canonical audit/concurrency columns
--    (mirrors the db/05 / 026 idioms). contract_no is the document number; the
--    unique (company_id, contract_no) keeps it unique within a tenant. Numeric
--    money columns are NUMERIC(20,4); pct columns NUMERIC(9,4).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales.customer_contract (
    contract_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_id           BIGINT REFERENCES mdm.business_unit(bu_id),
    contract_no     VARCHAR(30) NOT NULL,
    customer_id     BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    project_id      BIGINT REFERENCES proj.project(project_id),
    title           VARCHAR(200),
    contract_value  NUMERIC(20,4) NOT NULL DEFAULT 0,
    currency_id     BIGINT REFERENCES mdm.currency(currency_id),
    payment_terms   VARCHAR(300),
    ld_penalty_pct  NUMERIC(9,4) NOT NULL DEFAULT 0,
    ld_cap_pct      NUMERIC(9,4) NOT NULL DEFAULT 0,
    warranty_months INT NOT NULL DEFAULT 0,
    start_date      DATE,
    end_date        DATE,
    status          VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    signed_date     DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      BIGINT REFERENCES sec.app_user(user_id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      BIGINT REFERENCES sec.app_user(user_id),
    row_version     INT NOT NULL DEFAULT 1,
    is_deleted      BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_customer_contract_no UNIQUE (company_id, contract_no),
    CONSTRAINT ck_customer_contract_status CHECK (status IN ('DRAFT','ACTIVE','CLOSED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS sales.contract_milestone (
    milestone_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id    BIGINT NOT NULL REFERENCES sales.customer_contract(contract_id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    milestone_pct  NUMERIC(9,4),
    amount         NUMERIC(20,4) NOT NULL DEFAULT 0,
    due_date       DATE,
    status         VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    sort_order     INT,
    CONSTRAINT ck_contract_milestone_status CHECK (status IN ('PENDING','INVOICED','PAID'))
);

-- ---------------------------------------------------------------------
-- 3. Numbering rule for 'CONTRACT' — branch-scoped, prefix 'CON', FY reset. Not
--    in the db/07 seed, so add one rule per BE branch. Mirrors the db/07 / 028
--    pattern; guarded so re-runs are no-ops. mdm.next_document_no(company,bu,
--    'CONTRACT') yields e.g. CON/MUM/2026-27/000001.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'CONTRACT', 'CON', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Helpful index for the List screen filters.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_customer_contract_company_status
  ON sales.customer_contract(company_id, status);
CREATE INDEX IF NOT EXISTS ix_contract_milestone_contract
  ON sales.contract_milestone(contract_id);

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (per-company) on the header. ENABLE (not FORCE): the
--    table owner / superuser BYPASSES RLS, so migrations + the test harness are
--    not filtered; enforcement applies ONLY to the non-superuser erp_app login
--    role. The milestone children are always reached via the parent contract (no
--    direct query path), so they carry no company_id and need no policy.
-- ---------------------------------------------------------------------
ALTER TABLE sales.customer_contract ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sales.customer_contract IS
  'RLS ENABLED (not FORCE): rls_contract_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Commercial customer contract: DRAFT -> ACTIVE -> CLOSED (+ CANCELLED). Distinct from svc.service_contract (the AMC / service contract).';

DROP POLICY IF EXISTS rls_contract_company ON sales.customer_contract;
CREATE POLICY rls_contract_company ON sales.customer_contract
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 6. BUSINESS-UNIT / COMPANY INTEGRITY: a contract's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) contract still works. uq_bu_company exists from
--    003. Guarded via pg_constraint so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_contract_bu_company'
      AND conrelid = 'sales.customer_contract'::regclass
  ) THEN
    ALTER TABLE sales.customer_contract
      ADD CONSTRAINT fk_contract_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGER. These tables are new (db/06 attaches trg_audit_* only to the
--    pre-existing high-value documents), so add the canonical audit.fn_audit on
--    the header (keyed on the pk contract_id) so every CREATE/EDIT/DELETE is
--    attributed. Guarded on pg_trigger so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_customer_contract'
      AND tgrelid = 'sales.customer_contract'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_customer_contract
      AFTER INSERT OR UPDATE OR DELETE ON sales.customer_contract
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('contract_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Grants. erp_app needs SELECT/INSERT/UPDATE on both tables (the header is
--    soft-delete only — no DELETE). The app fully (re-)inserts the milestone
--    children when a DRAFT contract is edited, so additionally grant DELETE on
--    the milestone child table (least privilege keeps the header DELETE-free).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    sales.customer_contract,
    sales.contract_milestone
TO erp_app;
GRANT DELETE ON sales.contract_milestone TO erp_app;

-- End migration 029_contract.
