-- =====================================================================
-- Change / Variation Management (Tier-1 gap #5) : incremental migration
-- Promotes the base proj.change_order (db/02) — a header-only engineering /
-- scope variation that re-costs and re-baselines a project — to the platform's
-- branch-numbering + multi-tenant RLS conventions and a formal approval
-- lifecycle:
--   DRAFT -> SUBMITTED -> APPROVED | REJECTED -> IMPLEMENTED  (+ CANCELLED)
-- Adds:
--   * bu_id   — branch, required to allocate a branch-scoped change number
--   * reason  — free-text rationale captured at create / submit / reject
--   * the new status CHECK (replaces the base DRAFT/PENDING/CUSTOMER_APPROVED/
--     REJECTED check; legacy rows are migrated first so the new CHECK attaches)
--   * a 'CHANGE_ORDER' numbering rule (branch-scoped, prefix 'CO') — not in the
--     db/07 seed, so we add one per BE branch (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/013)
--   * the composite (company_id, bu_id) FK and a List-screen (company,status) index
-- APPROVED emits 'change_order.approved' (transactional outbox) so M15
-- Profitability / Planning re-cost and re-baseline from the cost / price impact.
-- The audit trigger trg_audit_change_order is ALREADY attached in db/06
-- (change_order_id) — do NOT re-create (guarded below). company_id, row_version,
-- is_deleted already exist on proj.change_order (db/02).
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope) + rationale column. company_id already exists and
--    is NOT NULL (db/02); add only bu_id (the numbering scope) and reason.
-- ---------------------------------------------------------------------
ALTER TABLE proj.change_order
  ADD COLUMN IF NOT EXISTS bu_id  BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS reason TEXT;

-- company_id is already NOT NULL on proj.change_order (db/02); no backfill needed.
-- (Defensive backfill from the owning project in case a nullable column slipped in.)
UPDATE proj.change_order co
   SET company_id = p.company_id
  FROM proj.project p
 WHERE co.project_id = p.project_id
   AND co.company_id IS NULL;

-- ---------------------------------------------------------------------
-- 2. Lifecycle CHECK. Replace the base check (DRAFT/PENDING/CUSTOMER_APPROVED/
--    REJECTED, db/02) with the formal re-cost / re-baseline approval lifecycle.
--    Migrate any legacy rows first so the new CHECK can attach.
-- ---------------------------------------------------------------------
ALTER TABLE proj.change_order DROP CONSTRAINT IF EXISTS ck_co_status;
UPDATE proj.change_order SET status = CASE status
    WHEN 'PENDING'           THEN 'SUBMITTED'
    WHEN 'CUSTOMER_APPROVED' THEN 'APPROVED'
    ELSE status                         -- DRAFT / REJECTED stay as-is
  END
  WHERE status IN ('PENDING','CUSTOMER_APPROVED');
ALTER TABLE proj.change_order ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE proj.change_order ADD CONSTRAINT ck_co_status
  CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','IMPLEMENTED','CANCELLED'));

-- ---------------------------------------------------------------------
-- 3. Helpful index for the List screen filters (ix_co_project already exists
--    from db/02; add the company-scoped composite used by the list/export).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_co_company_status ON proj.change_order(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the dispatch surface (013).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERT sets company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK.
-- ---------------------------------------------------------------------
ALTER TABLE proj.change_order ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE proj.change_order IS
  'RLS ENABLED (not FORCE): rls_change_order_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Formal engineering/scope variation: DRAFT->SUBMITTED->APPROVED|REJECTED->IMPLEMENTED (+CANCELLED); APPROVED emits change_order.approved so Profitability/Planning re-cost and re-baseline.';

DROP POLICY IF EXISTS rls_change_order_company ON proj.change_order;
CREATE POLICY rls_change_order_company ON proj.change_order
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a change order's branch must belong to
--    its company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) change order still works. uq_bu_company exists
--    from 003_security_hardening.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_change_order_bu_company'
      AND conrelid = 'proj.change_order'::regclass
  ) THEN
    ALTER TABLE proj.change_order
      ADD CONSTRAINT fk_change_order_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. NUMBERING RULE for 'CHANGE_ORDER' — branch-scoped, prefix 'CO', FY reset.
--    Not present in the db/07 seed, so add one rule per BE branch. Mirrors the
--    db/07 / 012 pattern; guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'CHANGE_ORDER', 'CO', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGER. trg_audit_change_order is ALREADY attached in db/06
--    (change_order_id). Re-create only if it is somehow absent (e.g. db/06 not
--    applied in a given environment); guarded by a pg_trigger existence check.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_change_order'
      AND tgrelid = 'proj.change_order'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_change_order
      AFTER INSERT OR UPDATE OR DELETE ON proj.change_order
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('change_order_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. GRANTS. erp_app already has SELECT/INSERT/UPDATE on proj.* from db/08;
--    re-assert defensively. The parent keeps soft-delete only (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON proj.change_order TO erp_app;

-- End migration 025_change.
