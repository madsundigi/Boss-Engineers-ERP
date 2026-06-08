-- =====================================================================
-- Tier-3 — Project Risk Register : new module
-- Creates proj.project_risk (5x5 likelihood x impact matrix, severity computed
-- as a STORED generated column, mitigation + owner + lifecycle), seeds the new
-- 'RISK' RBAC domain (absent from db/08), and wires per-company RLS, the
-- composite (company_id, bu_id) FK, an audit trigger, and erp_app grants.
-- Idempotent. Apply AFTER db/00_run_all.sql and the earlier migrations.
-- =====================================================================

-- 1. RBAC: seed the RISK permission domain + role grants (flag-letter idiom, db/08).
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'RISK.' || a, 'RISK', a, a || ' on RISK'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('PLANNING','VCEDA'),('CEO','VAX'),('ADMIN','VCEDAX'),
    ('PRODUCTION','VCE'),('QC','VC'),('FINANCE','V'),('SALES','V')
  ) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter, action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'RISK' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- 2. Table.
CREATE TABLE IF NOT EXISTS proj.project_risk (
  risk_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
  bu_id        BIGINT REFERENCES mdm.business_unit(bu_id),
  project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  category     VARCHAR(20) CHECK (category IN ('SCHEDULE','COST','QUALITY','SUPPLY','SAFETY','COMMERCIAL','TECHNICAL')),
  likelihood   SMALLINT NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  impact       SMALLINT NOT NULL CHECK (impact BETWEEN 1 AND 5),
  severity     SMALLINT GENERATED ALWAYS AS (likelihood * impact) STORED,
  mitigation   TEXT,
  owner_id     BIGINT REFERENCES sec.app_user(user_id),
  due_date     DATE,
  status       VARCHAR(15) NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','MITIGATING','CLOSED','ACCEPTED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES sec.app_user(user_id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES sec.app_user(user_id),
  row_version  INTEGER NOT NULL DEFAULT 1,
  is_deleted   BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_project_risk_scope ON proj.project_risk(company_id, project_id, status);

-- 3. Row-Level Security (per-company), mirroring the other business tables.
ALTER TABLE proj.project_risk ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE proj.project_risk IS
  'RLS ENABLED (not FORCE): rls_project_risk_company scopes rows to app.company_id for erp_app; the owner/superuser bypasses (tests + migrations).';
DROP POLICY IF EXISTS rls_project_risk_company ON proj.project_risk;
CREATE POLICY rls_project_risk_company ON proj.project_risk
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4. Branch/company integrity: a risk's branch must belong to its company.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_project_risk_bu_company' AND conrelid = 'proj.project_risk'::regclass
  ) THEN
    ALTER TABLE proj.project_risk
      ADD CONSTRAINT fk_project_risk_bu_company
      FOREIGN KEY (company_id, bu_id) REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- 5. Audit trigger (field-level) if not already attached.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_project_risk') THEN
    CREATE TRIGGER trg_audit_project_risk
      AFTER INSERT OR UPDATE OR DELETE ON proj.project_risk
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('risk_id');
  END IF;
END $$;

-- 6. Grants for the RLS-enforced app role.
GRANT SELECT, INSERT, UPDATE ON proj.project_risk TO erp_app;

-- End migration 031_risk.
