-- =====================================================================
-- Module — Document Management System (DMS, FRD §11 Tier-2) : new module
-- A versioned document repository (drawings, specs, test certificates, contracts,
-- reports, manuals) with access control. There is NO base table for it, so this
-- migration CREATES a NEW schema + two tables:
--   dms.document          (header)   — one logical document, current_version pointer
--   dms.document_version  (children) — its immutable version history
--
-- IMPORTANT — pointer only, not the bytes. The actual file content lives in
-- EXTERNAL object storage (S3 / blob). The CLIENT uploads the file to object
-- storage and passes the resulting object key/URL; this module stores only the
-- storage_key POINTER + metadata (file_name / mime_type / size_bytes), never the
-- file body itself.
--
-- It seeds the 'DOCUMENT' RBAC domain (absent from db/08) + the 'DOCUMENT'
-- numbering rule (prefix 'DOC', absent from db/07), enables per-company Row-Level
-- Security on the header, adds the composite (company_id, bu_id) FK, attaches the
-- canonical audit trigger (db/06 has none for these new tables), and grants
-- erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 037.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SCHEMA. The DMS gets its own namespace. GRANT USAGE so the RLS-enforced
--    erp_app role can reach the objects (table grants below add the DML).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS dms;
GRANT USAGE ON SCHEMA dms TO erp_app;

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'DOCUMENT' permission domain (db/08 has no such module)
--    and grant it to roles. ADMIN holds all six (VCEDAX); PLANNING/PRODUCTION/
--    QC/SALES own documents (VCE); SERVICE (VC); PURCHASE/FINANCE/INSTALL/STORES
--    read (V); CEO views + exports (VX). perm_code is 'DOCUMENT.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'DOCUMENT.'||a,'DOCUMENT',a,a||' on DOCUMENT' FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('ADMIN','VCEDAX'),('PLANNING','VCE'),('PRODUCTION','VCE'),('QC','VCE'),('SALES','VCE'),
    ('SERVICE','VC'),('PURCHASE','V'),('FINANCE','V'),('INSTALL','V'),('STORES','V'),('CEO','VX')
  ) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action) ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='DOCUMENT' AND p.action=f.action ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLES. The document header + its version history. bigint-identity PKs +
--    the canonical audit/concurrency columns (mirrors the db/05 / 029 idioms).
--    doc_no is the document number; the unique (company_id, doc_no) keeps it
--    unique within a tenant. current_version is a pointer to the latest version
--    no (0 until the first version is added).
--    storage_key is the EXTERNAL object-store key/URL — the file body itself is
--    NOT stored in the database (see header note).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dms.document (
    doc_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_id           BIGINT REFERENCES mdm.business_unit(bu_id),
    doc_no          VARCHAR(30) NOT NULL,
    title           VARCHAR(200) NOT NULL,
    category        VARCHAR(15),
    entity_type     VARCHAR(20),
    entity_id       BIGINT,
    current_version INT NOT NULL DEFAULT 0,
    status          VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    owner_id        BIGINT REFERENCES sec.app_user(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      BIGINT REFERENCES sec.app_user(user_id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      BIGINT REFERENCES sec.app_user(user_id),
    row_version     INT NOT NULL DEFAULT 1,
    is_deleted      BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_dms_document_no UNIQUE (company_id, doc_no),
    CONSTRAINT ck_dms_document_category CHECK (category IN ('DRAWING','SPEC','CERTIFICATE','CONTRACT','REPORT','MANUAL','OTHER')),
    CONSTRAINT ck_dms_document_status CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED','OBSOLETE'))
);

CREATE TABLE IF NOT EXISTS dms.document_version (
    version_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id       BIGINT NOT NULL REFERENCES dms.document(doc_id) ON DELETE CASCADE,
    version_no   INT NOT NULL,
    storage_key  VARCHAR(400) NOT NULL,
    file_name    VARCHAR(200),
    mime_type    VARCHAR(100),
    size_bytes   BIGINT,
    notes        VARCHAR(300),
    uploaded_by  BIGINT REFERENCES sec.app_user(user_id),
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_dms_document_version_no UNIQUE (doc_id, version_no)
);

-- ---------------------------------------------------------------------
-- 3. Numbering rule for 'DOCUMENT' — branch-scoped, prefix 'DOC', FY reset. Not
--    in the db/07 seed, so add one rule per BE branch. Mirrors the db/07 / 029
--    pattern; guarded so re-runs are no-ops. mdm.next_document_no(company,bu,
--    'DOCUMENT') yields e.g. DOC/MUM/2026-27/000001.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'DOCUMENT', 'DOC', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. Helpful indexes for the List screen filters.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_dms_document_company_cat_status
  ON dms.document(company_id, category, status);
CREATE INDEX IF NOT EXISTS ix_dms_document_version_doc
  ON dms.document_version(doc_id);

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (per-company) on the header. ENABLE (not FORCE): the
--    table owner / superuser BYPASSES RLS, so migrations + the test harness are
--    not filtered; enforcement applies ONLY to the non-superuser erp_app login
--    role. The version children are always reached via the parent document (no
--    direct query path), so they carry no company_id and need no policy.
-- ---------------------------------------------------------------------
ALTER TABLE dms.document ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE dms.document IS
  'RLS ENABLED (not FORCE): rls_dms_document_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Versioned document repository: DRAFT -> ACTIVE -> ARCHIVED (+ OBSOLETE). Files live in EXTERNAL object storage; dms.document_version.storage_key is the pointer only — the file body is NOT stored in the database.';

DROP POLICY IF EXISTS rls_dms_document_company ON dms.document;
CREATE POLICY rls_dms_document_company ON dms.document
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 6. BUSINESS-UNIT / COMPANY INTEGRITY: a document's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) document still works. uq_bu_company exists from
--    003. Guarded via pg_constraint so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_dms_document_bu_company'
      AND conrelid = 'dms.document'::regclass
  ) THEN
    ALTER TABLE dms.document
      ADD CONSTRAINT fk_dms_document_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGER. These tables are new (db/06 attaches trg_audit_* only to the
--    pre-existing high-value documents), so add the canonical audit.fn_audit on
--    the header (keyed on the pk doc_id) so every CREATE/EDIT/DELETE is
--    attributed. Guarded on pg_trigger so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_dms_document'
      AND tgrelid = 'dms.document'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_dms_document
      AFTER INSERT OR UPDATE OR DELETE ON dms.document
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('doc_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Grants. erp_app needs SELECT/INSERT/UPDATE on both tables (the header is
--    soft-delete only — no DELETE). The version children are immutable history
--    on add, but a soft-deleted document's versions cascade on a future hard
--    delete; grant DELETE on the version child table (least privilege keeps the
--    header DELETE-free).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    dms.document,
    dms.document_version
TO erp_app;
GRANT DELETE ON dms.document_version TO erp_app;

-- End migration 038_dms.
