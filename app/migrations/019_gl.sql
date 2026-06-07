-- =====================================================================
-- Module — Finance General Ledger (GL) : incremental migration
-- Brings the base double-entry ledger (db/05_fin_audit_rpt.sql) up to the
-- platform's branch-numbering + multi-tenant RLS conventions so the GL module
-- can serve it through the RLS-enforced erp_app role:
--   * fin.gl_entry.bu_id  — branch, the numbering scope for the JOURNAL number
--                           (company_id already exists on gl_entry, db/05)
--   * a 'JOURNAL' numbering rule (branch-scoped, prefix 'JV', FY reset) — NOT in
--     the db/07 seed, so we add it here (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app on mdm.gl_account,
--     fin.gl_entry and fin.project_cost_ledger (ENABLE, not FORCE: the owner/
--     superuser used by tests + migrations bypasses, exactly like 003/012/013)
--   * defensive SELECT/INSERT grants (+ UPDATE on gl_account for setActive)
-- IMPORTANT — APPEND-ONLY + PARTITIONED:
--   fin.gl_entry and fin.project_cost_ledger are PARTITIONED BY RANGE(posting_date)
--   with monthly partitions (created by db/06's partition automation for current +
--   next 2 months) plus a DEFAULT partition. ENABLE RLS on the PARENT only —
--   Postgres applies the policy to every partition. The two ledgers are immutable
--   (insert + select only): NO UPDATE/DELETE grant is wanted on them. gl_entry_line
--   has no company_id and is reached only via gl_entry, so it carries no RLS policy.
-- The GL permission catalog (GL.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT}) and the
-- grants (FINANCE=VCEDAX, CEO=VX, ADMIN=V) are ALREADY seeded in db/08; re-assert
-- defensively below so this module is self-contained, guarded so re-runs are no-ops.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists on fin.gl_entry
--    (db/05); add only bu_id. fin.project_cost_ledger is not numbered (no bu_id).
-- ---------------------------------------------------------------------
ALTER TABLE fin.gl_entry
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. NUMBERING RULE for 'JOURNAL' — branch-scoped, prefix 'JV', FY reset.
--    Not present in the db/07 seed, so add one rule per BE branch. Mirrors the
--    db/07 / 012 pattern; guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'JOURNAL', 'JV', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helpful indexes for the List screen + per-account ledger. The base schema
--    (db/05) already creates ix_gl_line_gl on gl_entry_line(gl_id) and
--    ix_gl_entry_date on gl_entry(posting_date); add the company-scoped composite
--    used by listJournals / trial balance (guarded names, distinct from db/05).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_gl_entry_company_date ON fin.gl_entry(company_id, posting_date);
CREATE INDEX IF NOT EXISTS ix_gl_line_gl_module     ON fin.gl_entry_line(gl_id);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003/013).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERTs set company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK. For the PARTITIONED ledgers, enabling RLS on the parent
--    applies the policy to all partitions automatically.
-- ---------------------------------------------------------------------

-- 4a. Chart of accounts (mdm.gl_account).
ALTER TABLE mdm.gl_account ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE mdm.gl_account IS
  'RLS ENABLED (not FORCE): rls_gl_account_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Chart of accounts master (no row_version/soft-delete).';

DROP POLICY IF EXISTS rls_gl_account_company ON mdm.gl_account;
CREATE POLICY rls_gl_account_company ON mdm.gl_account
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4b. Journal header (fin.gl_entry) — PARTITIONED; policy applies to all partitions.
ALTER TABLE fin.gl_entry ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.gl_entry IS
  'RLS ENABLED (not FORCE): rls_gl_entry_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). APPEND-ONLY double-entry journal, PARTITIONED BY RANGE(posting_date) — every insert carries posting_date (partition key + composite PK); journals are immutable (corrections post a reversing journal).';

DROP POLICY IF EXISTS rls_gl_entry_company ON fin.gl_entry;
CREATE POLICY rls_gl_entry_company ON fin.gl_entry
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4c. Project cost ledger (fin.project_cost_ledger) — PARTITIONED; policy applies to all partitions.
ALTER TABLE fin.project_cost_ledger ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.project_cost_ledger IS
  'RLS ENABLED (not FORCE): rls_project_cost_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). APPEND-ONLY project cost ledger (BUDGET/COMMITTED/ACTUAL by cost type), PARTITIONED BY RANGE(posting_date).';

DROP POLICY IF EXISTS rls_project_cost_company ON fin.project_cost_ledger;
CREATE POLICY rls_project_cost_company ON fin.project_cost_ledger
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. GRANTS. The erp_app role needs SELECT/INSERT on the chart of accounts and
--    both ledgers (+ gl_entry_line), plus UPDATE on mdm.gl_account for setActive.
--    The ledgers are append-only: no UPDATE/DELETE grant is needed or wanted.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON mdm.gl_account, fin.gl_entry, fin.gl_entry_line, fin.project_cost_ledger TO erp_app;
GRANT UPDATE ON mdm.gl_account TO erp_app;

-- ---------------------------------------------------------------------
-- 6. RBAC re-assert (defensive). The GL permission catalog + role grants are
--    already seeded in db/08 (GL.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT};
--    FINANCE=VCEDAX, CEO=VX, ADMIN=V). Re-assert idempotently so the module is
--    self-contained when applied against a database that predates that seed.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'GL.' || a.action, 'GL', a.action, a.action || ' on GL'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('CEO','GL','VX'), ('ADMIN','GL','V'), ('FINANCE','GL','VCEDAX')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- End migration 019_gl.
