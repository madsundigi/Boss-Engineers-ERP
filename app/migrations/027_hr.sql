-- =====================================================================
-- Module: HRMS core — incremental migration
-- Adds the HR self-service surface over the existing base HCM tables
-- (db/03_hcm_mfg_scm.sql): employee master CRUD, department/designation
-- reference data, and the leave application + approval workflow. The
-- allocation/timesheet tables are owned by the Workload module (M07,
-- migration 008) and are READ-ONLY here — this migration NEVER touches
-- hcm.resource_allocation / hcm.timesheet / hcm.timesheet_line and never
-- alters a Workload-owned policy, constraint, or grant.
--
-- ADDITIVE ONLY + idempotent. hcm.employee already ships the platform
-- audit/concurrency columns (row_version, is_deleted, created_*/updated_*)
-- from db/03, so this migration only:
--   * brings hcm.leave up to the workflow conventions (approver, dates,
--     reason, row_version, the CANCELLED state) — guarded ADD COLUMN
--   * seeds the LEAVE.* permission domain + role grants (db/08 has no LEAVE)
--   * enables per-company RLS on hcm.employee + hcm.leave ONLY IF a policy
--     is not already present (Workload enabled RLS on the alloc/timesheet
--     tables, NOT on employee/leave — checked via pg_policies)
--   * attaches audit triggers for employee/leave IF db/06 lacks them
--     (db/06 covers quotation/project/po/wo/fat/dispatch/invoice/... but
--     NOT hcm.employee or hcm.leave) — guarded via pg_trigger
--   * GRANTs SELECT/INSERT/UPDATE to erp_app (idempotent)
-- Apply AFTER db/00_run_all.sql, 005_rls_role_grants.sql and 008_workload.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. hcm.leave — workflow columns. The base table (db/03) has only
--    leave_id, employee_id, from_date, to_date, leave_type, status. Add the
--    approval attribution, the computed day count, a reason, and optimistic
--    concurrency. All guarded so re-apply is a no-op.
-- ---------------------------------------------------------------------
ALTER TABLE hcm.leave
  ADD COLUMN IF NOT EXISTS days        NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS reason      VARCHAR(300),
  ADD COLUMN IF NOT EXISTS approver_id BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

-- Widen the status lifecycle to include CANCELLED (base CHECK allows only
-- PENDING/APPROVED/REJECTED). Replace ONLY this CHECK; never drop a base CHECK
-- of another table. Drop-if-exists then re-add so the new state is allowed.
ALTER TABLE hcm.leave DROP CONSTRAINT IF EXISTS ck_leave_status;
ALTER TABLE hcm.leave ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE hcm.leave ADD CONSTRAINT ck_leave_status
  CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED'));

-- ---------------------------------------------------------------------
-- 2. Helpful indexes for the List screens (idempotent).
--    employee(company_id,status) for the dept/status filtered roster;
--    leave(employee_id,status) for the per-employee approval queue.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_employee_company_status ON hcm.employee(company_id, status);
CREATE INDEX IF NOT EXISTS ix_leave_emp_status        ON hcm.leave(employee_id, status);

-- ---------------------------------------------------------------------
-- 3. RBAC: seed the LEAVE permission domain (db/08 ships EMPLOYEE but NOT
--    LEAVE) and grant it to the operating roles. EMPLOYEE.* already exists
--    (HR/ADMIN VCEDX; CEO VX; PLANNING/FINANCE V) and is reused for
--    employee + department + designation CRUD/reads/export.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'LEAVE.'||a,'LEAVE',a,a||' on LEAVE'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES ('HR','VCEDAX'),('PLANNING','VA'),('PRODUCTION','VC'),('ADMIN','V'),('CEO','V'),('FINANCE','V')) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action)
  ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='LEAVE' AND p.action=f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003) and
--    Workload (008). ENABLE (not FORCE): the owner/superuser used by tests +
--    migrations BYPASSES RLS; only the non-superuser erp_app login role is
--    filtered. Workload enabled RLS on the alloc/timesheet tables but NOT on
--    hcm.employee / hcm.leave, so we add it here — but ONLY if a policy is not
--    already present (so a future Workload change cannot be clobbered).
--    hcm.leave has no company_id of its own; it is scoped transitively through
--    its owning employee (mirrors timesheet_line -> timesheet in 008).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='hcm' AND tablename='employee'
  ) THEN
    EXECUTE 'ALTER TABLE hcm.employee ENABLE ROW LEVEL SECURITY';
    EXECUTE $p$
      CREATE POLICY rls_employee_company ON hcm.employee
        FOR ALL TO erp_app
        USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
    $p$;
    EXECUTE $c$COMMENT ON TABLE hcm.employee IS
      'RLS ENABLED (not FORCE): rls_employee_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).'$c$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='hcm' AND tablename='leave'
  ) THEN
    EXECUTE 'ALTER TABLE hcm.leave ENABLE ROW LEVEL SECURITY';
    -- Scope a leave row to the tenant via its owning employee (no own company_id).
    EXECUTE $p$
      CREATE POLICY rls_leave_company ON hcm.leave
        FOR ALL TO erp_app
        USING (EXISTS (
          SELECT 1 FROM hcm.employee e
           WHERE e.employee_id = hcm.leave.employee_id
             AND e.company_id = NULLIF(current_setting('app.company_id', true), '')::bigint))
        WITH CHECK (EXISTS (
          SELECT 1 FROM hcm.employee e
           WHERE e.employee_id = hcm.leave.employee_id
             AND e.company_id = NULLIF(current_setting('app.company_id', true), '')::bigint))
    $p$;
    EXECUTE $c$COMMENT ON TABLE hcm.leave IS
      'RLS ENABLED (not FORCE): rls_leave_company scopes rows to app.company_id via the owning employee for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).'$c$;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. AUDIT triggers (reuse the platform audit.fn_audit, parameterized by PK).
--    db/06 attaches audit triggers to quotation/project/po/wo/fat/dispatch/
--    invoice/customer/vendor but NOT to hcm.employee or hcm.leave — add them
--    if (and only if) absent, so attribution flows from the app.* session GUCs.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'hcm.employee'::regclass AND tgname = 'trg_audit_employee'
  ) THEN
    CREATE TRIGGER trg_audit_employee
      AFTER INSERT OR UPDATE OR DELETE ON hcm.employee
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('employee_id');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'hcm.leave'::regclass AND tgname = 'trg_audit_leave'
  ) THEN
    CREATE TRIGGER trg_audit_leave
      AFTER INSERT OR UPDATE OR DELETE ON hcm.leave
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('leave_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. GRANTS for the erp_app role (idempotent). db/08 may already grant these
--    on the hcm tables; GRANT is additive so re-running is harmless. The app
--    soft-deletes the employee (is_deleted) and status-manages leave, so no
--    DELETE grant is needed on either.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON hcm.employee    TO erp_app;
GRANT SELECT, INSERT, UPDATE ON hcm.department  TO erp_app;
GRANT SELECT, INSERT, UPDATE ON hcm.designation TO erp_app;
GRANT SELECT, INSERT, UPDATE ON hcm.leave       TO erp_app;

-- End migration 027_hr.
