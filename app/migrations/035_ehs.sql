-- =====================================================================
-- Tier-3 — EHS / Incident Register : new module
-- Environment-Health-Safety incident reporting with investigation + closure. The
-- base model has NO EHS schema at all, so this migration CREATES a new 'ehs' schema
-- with one table:
--   ehs.incident — a branch-numbered (INC) EHS incident: an INJURY / NEARMISS /
--                  SPILL / FIRE / PROPERTY / OTHER event, triaged by severity, with a
--                  REPORTED -> INVESTIGATING -> CLOSED lifecycle and a corrective
--                  action recorded before sign-off (close).
--
-- It seeds the 'EHS' RBAC domain (absent from the db/08 catalog) — anyone on the floor
-- can REPORT, while QC owns the investigation + closure — registers a branch-scoped
-- 'INCIDENT' document-numbering rule (prefix 'INC', not in the db/07 seed), enables
-- per-company Row-Level Security, wires the composite (company_id, bu_id) FK, the audit
-- trigger (db/06 has none for this new table), and grants erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and the earlier
-- migrations. RLS is ENABLE (not FORCE): the owner/superuser used by migrations +
-- the integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SCHEMA. EHS gets its own namespace (not in db/01). erp_app must be able to reach
--    it, so grant USAGE (table-level DML is granted in step 8).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ehs;
GRANT USAGE ON SCHEMA ehs TO erp_app;

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'EHS' permission domain (db/08 has no such module) and grant it
--    to roles (flag-letter idiom, db/08 / 031 / 033). Anyone on the shop floor can
--    REPORT an incident, so the operational roles get VC (view + create); QC owns the
--    investigation + closure (VCEDA), ADMIN holds all six (VCEDAX), CEO views +
--    approves/signs off + exports (VAX), HR can also report (VC). perm_code is
--    'EHS.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'EHS.' || a, 'EHS', a, a || ' on EHS'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('PRODUCTION','VC'),('STORES','VC'),('INSTALL','VC'),('SERVICE','VC'),
    ('QC','VCEDA'),('PURCHASE','VC'),('PLANNING','VC'),
    ('ADMIN','VCEDAX'),('CEO','VAX'),('HR','VC')
  ) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter, action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'EHS' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLE. The incident register. bigint-identity PK + the canonical audit/
--    concurrency columns (mirrors db/05 / 031 / 033). incident_no is the branch-scoped
--    document number; reported_by records who logged it; closed_at is stamped on
--    sign-off. project_id is an optional link to proj.project.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ehs.incident (
  incident_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT NOT NULL REFERENCES mdm.company(company_id),
  bu_id              BIGINT REFERENCES mdm.business_unit(bu_id),
  incident_no        VARCHAR(30) NOT NULL,
  incident_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  incident_type      VARCHAR(15) NOT NULL
                       CHECK (incident_type IN ('INJURY','NEARMISS','SPILL','FIRE','PROPERTY','OTHER')),
  severity           VARCHAR(10) NOT NULL DEFAULT 'LOW'
                       CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  location           VARCHAR(100),
  project_id         BIGINT REFERENCES proj.project(project_id),
  description        TEXT NOT NULL,
  corrective_action  TEXT,
  status             VARCHAR(15) NOT NULL DEFAULT 'REPORTED'
                       CHECK (status IN ('REPORTED','INVESTIGATING','CLOSED')),
  reported_by        BIGINT REFERENCES sec.app_user(user_id),
  closed_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT REFERENCES sec.app_user(user_id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT REFERENCES sec.app_user(user_id),
  row_version        INTEGER NOT NULL DEFAULT 1,
  is_deleted         BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------
-- 3. Index for the List screen filters (company + status scope).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ehs_incident_company_status ON ehs.incident(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company). ENABLE (not FORCE): the table owner /
--    superuser BYPASSES RLS, so migrations + the test harness are not filtered;
--    enforcement applies ONLY to the non-superuser erp_app login role. Scope is taken
--    from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE ehs.incident ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ehs.incident IS
  'RLS ENABLED (not FORCE): rls_ehs_incident_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Branch-numbered EHS incident with a REPORTED -> INVESTIGATING -> CLOSED lifecycle.';
DROP POLICY IF EXISTS rls_ehs_incident_company ON ehs.incident;
CREATE POLICY rls_ehs_incident_company ON ehs.incident
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: an incident's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL. uq_bu_company
--    exists from 003_security_hardening.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_ehs_incident_bu_company'
      AND conrelid = 'ehs.incident'::regclass
  ) THEN
    ALTER TABLE ehs.incident
      ADD CONSTRAINT fk_ehs_incident_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. NUMBERING RULE for 'INCIDENT' — branch-scoped, prefix 'INC', FY reset. Not present
--    in the db/07 seed, so add one rule per BE branch. Mirrors the db/07 / 012 pattern;
--    guarded so re-runs are no-ops. mdm.next_document_no(company,bu,'INCIDENT')
--    allocates the document number atomically in the create transaction.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'INCIDENT', 'INC', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGER. The table is new (db/06 attaches trg_audit_* only to the
--    pre-existing high-value documents), so add the canonical audit.fn_audit (keyed on
--    incident_id) so every CREATE/EDIT/DELETE is attributed. Guarded on pg_trigger so
--    re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_ehs_incident'
      AND tgrelid = 'ehs.incident'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_ehs_incident
      AFTER INSERT OR UPDATE OR DELETE ON ehs.incident
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('incident_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Grants. erp_app needs SELECT/INSERT/UPDATE (soft-delete only — no DELETE grant;
--    incidents are retired via is_deleted).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON ehs.incident TO erp_app;

-- End migration 035_ehs.
