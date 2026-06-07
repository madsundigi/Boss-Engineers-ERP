-- =====================================================================
-- Module M15 — Project Profitability & Margin Analysis : incremental migration
-- Extends base fin.margin_snapshot (db/05) — an APPEND-ONLY margin-snapshot log
-- (no status, no row_version, no soft-delete) — with the tenant column and
-- per-company Row-Level Security needed so the non-superuser erp_app role only
-- sees its own company's snapshots. There is NO numbering scope (snapshots are not
-- numbered documents) and NO bu_id. A snapshot is computed from the cost ledger
-- (fin.project_cost_ledger, by cost_stage) + invoices (fin.invoice taxable_amount)
-- and is immutable: re-computing inserts a fresh row (latest wins).
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql).
-- =====================================================================

-- 1. Tenant column for RLS scoping. fin.margin_snapshot (db/05) has no company_id;
--    add it (nullable so the ADD is non-blocking) then backfill from the owning
--    project.
ALTER TABLE fin.margin_snapshot
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

UPDATE fin.margin_snapshot m
   SET company_id = p.company_id
  FROM proj.project p
 WHERE m.project_id = p.project_id
   AND m.company_id IS NULL;

-- 2. Helpful index for the List / latest-snapshot lookups (newest first).
--    (db/05 already creates ix_margin_project on (project_id, snapshot_date DESC);
--    re-assert idempotently so this module is self-contained.)
CREATE INDEX IF NOT EXISTS ix_margin_snapshot_project_date
  ON fin.margin_snapshot(project_id, snapshot_date DESC);

-- ---------------------------------------------------------------------
-- 3. ROW-LEVEL SECURITY (per-company), mirroring the dispatch surface (013).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERT sets company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK.
-- ---------------------------------------------------------------------
ALTER TABLE fin.margin_snapshot ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.margin_snapshot IS
  'RLS ENABLED (not FORCE): rls_margin_snapshot_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Append-only margin-snapshot log: each computeSnapshot is a new immutable row (no status/row_version/soft-delete); revenue = Σ non-CANCELLED invoice taxable_amount, costs summed from fin.project_cost_ledger by cost_stage.';

DROP POLICY IF EXISTS rls_margin_snapshot_company ON fin.margin_snapshot;
CREATE POLICY rls_margin_snapshot_company ON fin.margin_snapshot
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 4. GRANTS. erp_app reads the source ledgers (fin.project_cost_ledger, fin.invoice,
--    proj.project) from db/08 and needs SELECT/INSERT on the snapshot table.
--    Append-only — no UPDATE/DELETE grant is needed or wanted. Re-assert defensively.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON fin.margin_snapshot TO erp_app;

-- ---------------------------------------------------------------------
-- 5. RBAC re-assert (defensive). The PROFITABILITY permission catalog + role
--    grants are already seeded in db/08 (PROFITABILITY.{VIEW,CREATE,EDIT,DELETE,
--    APPROVE,EXPORT}; FINANCE=VCEAX, PLANNING=VA, CEO=VX, ADMIN=V). Re-assert
--    idempotently so the module is self-contained when applied against a database
--    that predates that seed. (Spec grant set — CREATE/EDIT->FINANCE; APPROVE->
--    FINANCE/PLANNING; VIEW->ADMIN/CEO/FINANCE/PLANNING; EXPORT->CEO/FINANCE.)
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'PROFITABILITY.' || a.action, 'PROFITABILITY', a.action, a.action || ' on PROFITABILITY'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('FINANCE','PROFITABILITY','VCEAX'),
    ('PLANNING','PROFITABILITY','VA'),
    ('CEO','PROFITABILITY','VX'),
    ('ADMIN','PROFITABILITY','V')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- End migration 023_profitability.
