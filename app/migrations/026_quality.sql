-- =====================================================================
-- QMS — Quality Inspection & Gauge Calibration : incremental migration
-- Brings the base qms.inspection family (db/04_qms_log_svc.sql) up to the
-- platform's workflow + branch-numbering + multi-tenant RLS conventions, and
-- ADDS a calibration register (qms.gauge + qms.calibration_record) which is not
-- in the base schema. Serves incoming / in-process / final inspection and the
-- ISO gauge-calibration control through the RLS-enforced erp_app role:
--   * a workflow `status` (PENDING -> PASS|FAIL|PARTIAL) + tenant/audit columns on
--     qms.inspection (db/04 ships only company_id, insp_no, insp_type, grn_id,
--     wo_id, insp_date, result — no status/row_version/audit columns)
--   * `parameter` + per-line `result` on qms.inspection_line (db/04 ships only the
--     sampling quantities)
--   * the 'INSPECTION' RBAC domain — sec.permission + sec.role_permission grants
--     (the INSPECTION.* permissions do NOT exist in db/08, so we seed them here)
--   * an 'INSPECTION' numbering rule (branch-scoped, prefix 'INSP') — not in the
--     db/07 seed, added here guarded ON CONFLICT DO NOTHING
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app on qms.inspection and
--     qms.gauge (ENABLE, not FORCE: the owner/superuser used by tests + migrations
--     bypasses, exactly like 003/013/016). qms.inspection_line and
--     qms.calibration_record carry no company_id — reached only via their parent —
--     so RLS on the parent suffices and is NOT added to the children.
--   * the composite (company_id, bu_id) FK and List-screen indexes
--   * field-level audit triggers trg_audit_inspection + trg_audit_gauge (NOT in
--     db/06) — added if absent, so CREATE/EDIT/DELETE land in audit.audit_log
--   * GRANTs for erp_app (the SELECT/INSERT/UPDATE ON ALL TABLES grant in db/06
--     predates the new gauge/calibration tables, so they are granted explicitly)
-- The base CHECKs ck_insp_type (INCOMING/IN_PROCESS/FINAL) and ck_insp_result
-- (PASS/FAIL/PARTIAL) already cover every value the module needs, so we do NOT
-- drop/replace them.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. WORKFLOW + TENANT + AUDIT columns on qms.inspection. company_id already
--    exists (db/04, NOT NULL). bu_id is the numbering scope. status drives the
--    PENDING -> PASS|FAIL|PARTIAL lifecycle; source_doc_type/item_id/project_id
--    peg the inspection; inspected_by + the standard audit/concurrency columns
--    mirror every other transactional table.
-- ---------------------------------------------------------------------
ALTER TABLE qms.inspection
  ADD COLUMN IF NOT EXISTS bu_id           BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS source_doc_type VARCHAR(10),
  ADD COLUMN IF NOT EXISTS item_id         BIGINT REFERENCES mdm.item(item_id),
  ADD COLUMN IF NOT EXISTS project_id      BIGINT REFERENCES proj.project(project_id),
  ADD COLUMN IF NOT EXISTS status          VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS inspected_by    BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by      BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by      BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS row_version     INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_deleted      BOOLEAN NOT NULL DEFAULT false;

-- inspection workflow status CHECK (guarded so re-runs are no-ops).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_insp_status' AND conrelid = 'qms.inspection'::regclass
  ) THEN
    ALTER TABLE qms.inspection
      ADD CONSTRAINT ck_insp_status CHECK (status IN ('PENDING','PASS','FAIL','PARTIAL'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_insp_source_doc' AND conrelid = 'qms.inspection'::regclass
  ) THEN
    ALTER TABLE qms.inspection
      ADD CONSTRAINT ck_insp_source_doc CHECK (source_doc_type IS NULL OR source_doc_type IN ('GRN','WO'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. Per-parameter columns on qms.inspection_line. db/04 ships only the sampling
--    quantities; add the inspected parameter name + per-line PASS/FAIL/PARTIAL.
-- ---------------------------------------------------------------------
ALTER TABLE qms.inspection_line
  ADD COLUMN IF NOT EXISTS parameter VARCHAR(120),
  ADD COLUMN IF NOT EXISTS result    VARCHAR(12);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_insp_line_result' AND conrelid = 'qms.inspection_line'::regclass
  ) THEN
    ALTER TABLE qms.inspection_line
      ADD CONSTRAINT ck_insp_line_result CHECK (result IS NULL OR result IN ('PASS','FAIL','PARTIAL'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. CALIBRATION REGISTER — new tables (not in the base schema).
--    qms.gauge: a measuring instrument with its calibration due date.
--    qms.calibration_record: each calibration event against a gauge.
--    Standard bigint-identity PKs, numeric where relevant, standard audit columns.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qms.gauge (
    gauge_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    gauge_code    VARCHAR(40) NOT NULL,
    gauge_name    VARCHAR(120) NOT NULL,
    gauge_type    VARCHAR(60),
    location      VARCHAR(120),
    last_cal_date DATE,
    next_cal_due  DATE,
    status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    BIGINT REFERENCES sec.app_user(user_id),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    BIGINT REFERENCES sec.app_user(user_id),
    row_version   INT NOT NULL DEFAULT 1,
    is_deleted    BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_gauge_code UNIQUE (company_id, gauge_code),
    CONSTRAINT ck_gauge_status CHECK (status IN ('ACTIVE','DUE','OUT_OF_CAL','RETIRED'))
);

CREATE TABLE IF NOT EXISTS qms.calibration_record (
    cal_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gauge_id       BIGINT NOT NULL REFERENCES qms.gauge(gauge_id) ON DELETE CASCADE,
    cal_date       DATE NOT NULL,
    due_date       DATE,
    result         VARCHAR(12) NOT NULL,
    certificate_no VARCHAR(60),
    calibrated_by  BIGINT REFERENCES sec.app_user(user_id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_cal_result CHECK (result IN ('PASS','FAIL','ADJUSTED'))
);

-- ---------------------------------------------------------------------
-- 4. RBAC: the 'INSPECTION' domain does NOT exist in db/08. Seed the permissions
--    and the per-role grants (QC=VCEDAX, PRODUCTION/STORES=VC, PURCHASE/ADMIN=V,
--    CEO=VX). Guarded ON CONFLICT DO NOTHING so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'INSPECTION.'||a, 'INSPECTION', a, a||' on INSPECTION'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES ('QC','VCEDAX'),('PRODUCTION','VC'),('STORES','VC'),
             ('PURCHASE','V'),('ADMIN','V'),('CEO','VX')) g(role_code,flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),
                     ('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'INSPECTION' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. NUMBERING RULE for 'INSPECTION' — branch-scoped, prefix 'INSP', FY reset.
--    Not present in the db/07 seed, so add one rule per BE branch. Mirrors 016.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'INSPECTION', 'INSP', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 6. Helpful indexes for the List screens.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_insp_company_status ON qms.inspection(company_id, status);
CREATE INDEX IF NOT EXISTS ix_gauge_company_status ON qms.gauge(company_id, status);
CREATE INDEX IF NOT EXISTS ix_gauge_next_cal_due  ON qms.gauge(next_cal_due);
CREATE INDEX IF NOT EXISTS ix_cal_gauge           ON qms.calibration_record(gauge_id);

-- ---------------------------------------------------------------------
-- 7. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    qms.inspection_line and qms.calibration_record have no company_id and are
--    reached only via their parent, so RLS on the parent suffices — no policy is
--    added to the children.
-- ---------------------------------------------------------------------
ALTER TABLE qms.inspection ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE qms.inspection IS
  'RLS ENABLED (not FORCE): rls_inspection_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Inspection lifecycle: PENDING->PASS|FAIL|PARTIAL; FAIL emits inspection.failed.';
DROP POLICY IF EXISTS rls_inspection_company ON qms.inspection;
CREATE POLICY rls_inspection_company ON qms.inspection
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

ALTER TABLE qms.gauge ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE qms.gauge IS
  'RLS ENABLED (not FORCE): rls_gauge_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Gauge calibration register; calibration_record is reached via the gauge so carries no policy.';
DROP POLICY IF EXISTS rls_gauge_company ON qms.gauge;
CREATE POLICY rls_gauge_company ON qms.gauge
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 8. BUSINESS-UNIT / COMPANY INTEGRITY: an inspection's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) inspection still works. uq_bu_company exists (003).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_inspection_bu_company'
      AND conrelid = 'qms.inspection'::regclass
  ) THEN
    ALTER TABLE qms.inspection
      ADD CONSTRAINT fk_inspection_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 9. AUDIT TRIGGERS. db/06 does NOT attach any trigger to qms.inspection or
--    qms.gauge. Add the field-level audit trigger (audit.fn_audit on the PK) if
--    absent, so CREATE/EDIT/DELETE are captured — mirroring trg_audit_ncr (016).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_inspection' AND tgrelid = 'qms.inspection'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_inspection
      AFTER INSERT OR UPDATE OR DELETE ON qms.inspection
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('inspection_id');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_gauge' AND tgrelid = 'qms.gauge'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_gauge
      AFTER INSERT OR UPDATE OR DELETE ON qms.gauge
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('gauge_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 10. GRANTS. The db/06 'GRANT ... ON ALL TABLES IN SCHEMA qms' predates the new
--     gauge / calibration_record tables, so grant erp_app explicitly. The child
--     tables may be removed (calibration records cascade when a gauge is deleted;
--     inspection lines could be replaced), so erp_app needs DELETE on the child
--     tables. The parents qms.inspection / qms.gauge keep soft-delete only (no
--     DELETE grant).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON qms.inspection, qms.inspection_line, qms.gauge, qms.calibration_record TO erp_app;
GRANT DELETE ON qms.inspection_line, qms.calibration_record TO erp_app;

-- End migration 026_quality.
