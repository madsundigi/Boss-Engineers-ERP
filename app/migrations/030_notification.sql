-- =====================================================================
-- Module — Notifications / Alerts (Tier-3 value-add) : incremental migration
-- A per-user notification store: any module/user can RAISE a notification for a
-- recipient, and every user can LIST + MARK-READ their own. There is NO base
-- table for it, so this migration CREATES one cross-cutting table:
--   sec.notification  — one row per (recipient user, alert)
--
-- It seeds the 'NOTIFICATION' RBAC domain (absent from db/08) and grants it
-- broadly (so any module/user can raise + read notifications), enables per-
-- company Row-Level Security, adds the (company_id, user_id, is_read) index the
-- list/badge queries need, and grants erp_app the DML it needs.
--
-- The table is append + mark-read only (no row_version, no soft-delete). It is
-- high-churn and low-value, so NO audit trigger is attached (deliberate).
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 029.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'NOTIFICATION' permission domain (db/08 has no such module)
--    and grant it to roles. ADMIN holds all six (VCEDAX); CEO views/creates/
--    exports (VCX); and VIEW+CREATE (VC) is granted to every operational role
--    (PLANNING, PRODUCTION, SALES, FINANCE, QC, STORES, PURCHASE, SERVICE,
--    INSTALL, HR) so ANY module/user can raise + read notifications. perm_code
--    is 'NOTIFICATION.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'NOTIFICATION.'||a,'NOTIFICATION',a,a||' on NOTIFICATION' FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
        ('ADMIN','VCEDAX'),('CEO','VCX'),
        ('PLANNING','VC'),('PRODUCTION','VC'),('SALES','VC'),('FINANCE','VC'),
        ('QC','VC'),('STORES','VC'),('PURCHASE','VC'),('SERVICE','VC'),
        ('INSTALL','VC'),('HR','VC')
     ) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action) ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='NOTIFICATION' AND p.action=f.action ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLE. One row per (recipient user, alert). bigint-identity PK. No
--    row_version / is_deleted: a notification is appended once and only ever
--    flips is_read (mark-read). category is a small CHECK enum. company_id is
--    the tenant column the RLS policy scopes on; user_id is the RECIPIENT.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sec.notification (
    notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES sec.app_user(user_id),
    category        VARCHAR(20) NOT NULL DEFAULT 'INFO',
    title           VARCHAR(200) NOT NULL,
    body            VARCHAR(1000),
    link            VARCHAR(300),
    is_read         BOOLEAN NOT NULL DEFAULT false,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      BIGINT,
    CONSTRAINT ck_notification_category CHECK (category IN ('INFO','WARNING','ERROR','APPROVAL'))
);

-- ---------------------------------------------------------------------
-- 3. Index for the inbox queries: list the caller's own (read/unread) rows and
--    count their unread badge — all filter (company_id, user_id, is_read).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_notification_company_user_read
  ON sec.notification(company_id, user_id, is_read);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company). ENABLE (not FORCE): the table owner /
--    superuser BYPASSES RLS, so migrations + the test harness are not filtered;
--    enforcement applies ONLY to the non-superuser erp_app login role. The
--    per-recipient scoping (user_id = caller) is enforced in the queries; the
--    policy guarantees cross-tenant isolation.
-- ---------------------------------------------------------------------
ALTER TABLE sec.notification ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sec.notification IS
  'RLS ENABLED (not FORCE): rls_notification_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Per-user in-app notification store: append + mark-read only (no row_version / soft-delete / audit trigger).';

DROP POLICY IF EXISTS rls_notification_company ON sec.notification;
CREATE POLICY rls_notification_company ON sec.notification
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. Grants. erp_app needs full DML: INSERT (raise/broadcast), SELECT (list),
--    UPDATE (mark-read), DELETE (the NOTIFICATION.DELETE permission exists for
--    a future prune path). No audit trigger is attached (high-churn, low-value).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON sec.notification TO erp_app;

-- End migration 030_notification.
