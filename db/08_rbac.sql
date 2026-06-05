-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 8 : RBAC (roles, permissions, grants)
-- 12 roles x 6 actions (View/Create/Edit/Delete/Approve/Export) x modules.
-- Deny-by-default; SoD enforced per-user by the approval engine + DOA.
-- Run AFTER 07.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 8.1 Roles (canonical 12; replaces the bootstrap seed from part 6)
-- ---------------------------------------------------------------------
DELETE FROM sec.role WHERE role_code IN ('PM','QA');   -- legacy bootstrap codes

INSERT INTO sec.role (role_code, role_name, description) VALUES
 ('CEO',       'Chief Executive',     'Portfolio oversight; top-tier approvals; read + export all'),
 ('ADMIN',     'System Administrator','Security & system administration; NO business approvals'),
 ('SALES',     'Sales',               'Enquiry & quotation'),
 ('PURCHASE',  'Purchase',            'Procurement: PR / RFQ / PO / vendor'),
 ('STORES',    'Stores',              'Inventory, GRN, material issue'),
 ('PRODUCTION','Production',          'Work orders, production confirmation'),
 ('PLANNING',  'Planning / PMO',      'Project, WBS, Gantt, change orders, forecast'),
 ('QC',        'Quality Control',     'FAT, inspection, NCR / RCA / CAPA'),
 ('INSTALL',   'Installation',        'Site installation & SAT'),
 ('SERVICE',   'Service',             'Warranty, service tickets, AMC'),
 ('FINANCE',   'Finance',             'Billing, AP/AR, GL, tax, profitability'),
 ('HR',        'Human Resources',     'Employee master, workload, timesheets')
ON CONFLICT (role_code) DO UPDATE
   SET role_name = EXCLUDED.role_name, description = EXCLUDED.description;

-- ---------------------------------------------------------------------
-- 8.2 Permission catalog : every module x every action  (perm_code = MODULE.ACTION)
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT m.code || '.' || a.action, m.code, a.action,
       a.action || ' on ' || m.code
FROM (VALUES
    ('CUSTOMER'),('VENDOR'),('ITEM'),('BOM'),('EMPLOYEE'),
    ('ENQUIRY'),('QUOTATION'),('PROJECT'),('PLANNING'),('CHANGE_ORDER'),('DELIVERY_FORECAST'),
    ('PURCHASE_REQ'),('PURCHASE_ORDER'),('GRN'),('INVENTORY'),('MATERIAL_ISSUE'),('CRITICAL_ITEM'),
    ('WORK_ORDER'),('PRODUCTION'),('WORKLOAD'),('TIMESHEET'),
    ('FAT'),('NCR_CAPA'),('DISPATCH'),('INSTALLATION'),('WARRANTY'),('SERVICE_TICKET'),
    ('INVOICE'),('AP_INVOICE'),('GL'),('PROFITABILITY'),('TAX'),
    ('DASHBOARD'),('REPORTS'),
    ('USER_MGMT'),('ROLE_MGMT'),('APPROVAL_CONFIG'),('AUDIT_LOG'),('SYSTEM_CONFIG')
) AS m(code)
CROSS JOIN (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 8.3 Role -> permission grants
--   Matrix encoded as (role, module, flags) where flags is a subset of
--   'VCEDAX'. A LATERAL expands each flag letter into the matching action.
-- ---------------------------------------------------------------------
INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    -- ---- Master data ----
    ('CEO','CUSTOMER','VX'),('ADMIN','CUSTOMER','VCEDX'),('SALES','CUSTOMER','VCEX'),
        ('PLANNING','CUSTOMER','V'),('INSTALL','CUSTOMER','V'),('SERVICE','CUSTOMER','VX'),('FINANCE','CUSTOMER','VX'),
    ('CEO','VENDOR','VX'),('ADMIN','VENDOR','VCEDX'),('PURCHASE','VENDOR','VCEX'),
        ('STORES','VENDOR','V'),('QC','VENDOR','V'),('SERVICE','VENDOR','V'),('FINANCE','VENDOR','VX'),
    ('CEO','ITEM','VX'),('ADMIN','ITEM','VCEDX'),('SALES','ITEM','V'),('PURCHASE','ITEM','V'),
        ('STORES','ITEM','VCE'),('PRODUCTION','ITEM','V'),('PLANNING','ITEM','VCE'),('QC','ITEM','V'),
        ('SERVICE','ITEM','V'),('FINANCE','ITEM','V'),
    ('CEO','BOM','V'),('ADMIN','BOM','VCEDX'),('PURCHASE','BOM','V'),('PRODUCTION','BOM','VCE'),
        ('PLANNING','BOM','VCE'),('QC','BOM','V'),('SERVICE','BOM','V'),
    ('CEO','EMPLOYEE','VX'),('ADMIN','EMPLOYEE','VCEDX'),('PLANNING','EMPLOYEE','V'),
        ('FINANCE','EMPLOYEE','V'),('HR','EMPLOYEE','VCEDX'),
    -- ---- Sales & project ----
    ('CEO','ENQUIRY','VX'),('ADMIN','ENQUIRY','V'),('SALES','ENQUIRY','VCEDX'),('PLANNING','ENQUIRY','V'),
    ('CEO','QUOTATION','VAX'),('ADMIN','QUOTATION','V'),('SALES','QUOTATION','VCEDX'),
        ('PLANNING','QUOTATION','V'),('FINANCE','QUOTATION','VAX'),
    ('CEO','PROJECT','VAX'),('ADMIN','PROJECT','V'),('SALES','PROJECT','V'),('PURCHASE','PROJECT','V'),
        ('STORES','PROJECT','V'),('PRODUCTION','PROJECT','V'),('PLANNING','PROJECT','VCEX'),('QC','PROJECT','V'),
        ('INSTALL','PROJECT','V'),('SERVICE','PROJECT','V'),('FINANCE','PROJECT','VAX'),('HR','PROJECT','V'),
    ('CEO','PLANNING','VX'),('ADMIN','PLANNING','V'),('PURCHASE','PLANNING','V'),('PRODUCTION','PLANNING','V'),
        ('PLANNING','PLANNING','VCEDAX'),('INSTALL','PLANNING','V'),('FINANCE','PLANNING','V'),('HR','PLANNING','V'),
    ('CEO','CHANGE_ORDER','VAX'),('ADMIN','CHANGE_ORDER','V'),('SALES','CHANGE_ORDER','VC'),
        ('PRODUCTION','CHANGE_ORDER','V'),('PLANNING','CHANGE_ORDER','VCEX'),('FINANCE','CHANGE_ORDER','VAX'),
    ('CEO','DELIVERY_FORECAST','VX'),('ADMIN','DELIVERY_FORECAST','V'),('SALES','DELIVERY_FORECAST','V'),
        ('PRODUCTION','DELIVERY_FORECAST','V'),('PLANNING','DELIVERY_FORECAST','VCEX'),('FINANCE','DELIVERY_FORECAST','V'),
    -- ---- Procurement & inventory ----
    ('CEO','PURCHASE_REQ','VX'),('ADMIN','PURCHASE_REQ','V'),('PURCHASE','PURCHASE_REQ','VCEDAX'),
        ('STORES','PURCHASE_REQ','VC'),('PRODUCTION','PURCHASE_REQ','VC'),('PLANNING','PURCHASE_REQ','VC'),
        ('SERVICE','PURCHASE_REQ','VC'),('FINANCE','PURCHASE_REQ','V'),
    ('CEO','PURCHASE_ORDER','VAX'),('ADMIN','PURCHASE_ORDER','V'),('PURCHASE','PURCHASE_ORDER','VCEDAX'),
        ('STORES','PURCHASE_ORDER','V'),('PRODUCTION','PURCHASE_ORDER','V'),('PLANNING','PURCHASE_ORDER','V'),
        ('FINANCE','PURCHASE_ORDER','VX'),
    ('CEO','GRN','VX'),('ADMIN','GRN','V'),('PURCHASE','GRN','V'),('STORES','GRN','VCEDAX'),
        ('QC','GRN','VE'),('FINANCE','GRN','VX'),
    ('CEO','INVENTORY','VX'),('ADMIN','INVENTORY','V'),('PURCHASE','INVENTORY','V'),('STORES','INVENTORY','VCEDAX'),
        ('PRODUCTION','INVENTORY','V'),('PLANNING','INVENTORY','V'),('QC','INVENTORY','V'),('INSTALL','INVENTORY','V'),
        ('SERVICE','INVENTORY','V'),('FINANCE','INVENTORY','VAX'),
    ('CEO','MATERIAL_ISSUE','VX'),('ADMIN','MATERIAL_ISSUE','V'),('STORES','MATERIAL_ISSUE','VCEDAX'),
        ('PRODUCTION','MATERIAL_ISSUE','VC'),('PLANNING','MATERIAL_ISSUE','V'),('FINANCE','MATERIAL_ISSUE','V'),
    ('CEO','CRITICAL_ITEM','VX'),('ADMIN','CRITICAL_ITEM','V'),('PURCHASE','CRITICAL_ITEM','VCEAX'),
        ('STORES','CRITICAL_ITEM','VE'),('PRODUCTION','CRITICAL_ITEM','V'),('PLANNING','CRITICAL_ITEM','VCE'),
        ('FINANCE','CRITICAL_ITEM','V'),
    -- ---- Production & HCM ----
    ('CEO','WORK_ORDER','VX'),('ADMIN','WORK_ORDER','V'),('STORES','WORK_ORDER','V'),
        ('PRODUCTION','WORK_ORDER','VCEDAX'),('PLANNING','WORK_ORDER','VC'),('QC','WORK_ORDER','V'),('FINANCE','WORK_ORDER','V'),
    ('CEO','PRODUCTION','VX'),('ADMIN','PRODUCTION','V'),('STORES','PRODUCTION','V'),
        ('PRODUCTION','PRODUCTION','VCEDX'),('PLANNING','PRODUCTION','V'),('QC','PRODUCTION','V'),('FINANCE','PRODUCTION','V'),
    ('CEO','WORKLOAD','VX'),('ADMIN','WORKLOAD','V'),('PRODUCTION','WORKLOAD','VE'),
        ('PLANNING','WORKLOAD','VCEX'),('FINANCE','WORKLOAD','V'),('HR','WORKLOAD','VCEAX'),
    ('CEO','TIMESHEET','VX'),('ADMIN','TIMESHEET','V'),('SALES','TIMESHEET','C'),('PURCHASE','TIMESHEET','C'),
        ('STORES','TIMESHEET','C'),('PRODUCTION','TIMESHEET','VCA'),('PLANNING','TIMESHEET','VCA'),('QC','TIMESHEET','C'),
        ('INSTALL','TIMESHEET','C'),('SERVICE','TIMESHEET','C'),('FINANCE','TIMESHEET','VX'),('HR','TIMESHEET','VCEDAX'),
    -- ---- Quality / dispatch / service ----
    ('CEO','FAT','VX'),('ADMIN','FAT','V'),('SALES','FAT','V'),('PRODUCTION','FAT','V'),
        ('PLANNING','FAT','V'),('QC','FAT','VCEDAX'),('INSTALL','FAT','V'),
    ('CEO','NCR_CAPA','VX'),('ADMIN','NCR_CAPA','V'),('PURCHASE','NCR_CAPA','V'),('STORES','NCR_CAPA','VC'),
        ('PRODUCTION','NCR_CAPA','VC'),('PLANNING','NCR_CAPA','V'),('QC','NCR_CAPA','VCEDAX'),
        ('INSTALL','NCR_CAPA','VC'),('SERVICE','NCR_CAPA','VC'),('FINANCE','NCR_CAPA','V'),
    ('CEO','DISPATCH','VX'),('ADMIN','DISPATCH','V'),('SALES','DISPATCH','V'),('STORES','DISPATCH','VCEX'),
        ('PRODUCTION','DISPATCH','V'),('PLANNING','DISPATCH','V'),('QC','DISPATCH','VA'),('INSTALL','DISPATCH','V'),
        ('SERVICE','DISPATCH','V'),('FINANCE','DISPATCH','VAX'),
    ('CEO','INSTALLATION','VX'),('ADMIN','INSTALLATION','V'),('SALES','INSTALLATION','V'),('PRODUCTION','INSTALLATION','V'),
        ('PLANNING','INSTALLATION','V'),('QC','INSTALLATION','V'),('INSTALL','INSTALLATION','VCEDAX'),
        ('SERVICE','INSTALLATION','V'),('FINANCE','INSTALLATION','V'),
    ('CEO','WARRANTY','VX'),('ADMIN','WARRANTY','V'),('SALES','WARRANTY','V'),('QC','WARRANTY','V'),
        ('INSTALL','WARRANTY','V'),('SERVICE','WARRANTY','VCEDAX'),('FINANCE','WARRANTY','VX'),
    ('CEO','SERVICE_TICKET','VX'),('ADMIN','SERVICE_TICKET','V'),('SALES','SERVICE_TICKET','V'),('QC','SERVICE_TICKET','V'),
        ('INSTALL','SERVICE_TICKET','V'),('SERVICE','SERVICE_TICKET','VCEDAX'),('FINANCE','SERVICE_TICKET','V'),
    -- ---- Finance ----
    ('CEO','INVOICE','VX'),('ADMIN','INVOICE','V'),('SALES','INVOICE','V'),('PLANNING','INVOICE','V'),
        ('SERVICE','INVOICE','V'),('FINANCE','INVOICE','VCEDAX'),
    ('CEO','AP_INVOICE','VX'),('ADMIN','AP_INVOICE','V'),('PURCHASE','AP_INVOICE','V'),('FINANCE','AP_INVOICE','VCEDAX'),
    ('CEO','GL','VX'),('ADMIN','GL','V'),('FINANCE','GL','VCEDAX'),
    ('CEO','PROFITABILITY','VX'),('ADMIN','PROFITABILITY','V'),('PLANNING','PROFITABILITY','VA'),('FINANCE','PROFITABILITY','VCEAX'),
    ('CEO','TAX','VX'),('ADMIN','TAX','V'),('FINANCE','TAX','VCEDAX'),
    -- ---- Analytics ----
    ('CEO','DASHBOARD','VX'),('ADMIN','DASHBOARD','V'),('SALES','DASHBOARD','V'),('PURCHASE','DASHBOARD','V'),
        ('STORES','DASHBOARD','V'),('PRODUCTION','DASHBOARD','V'),('PLANNING','DASHBOARD','V'),('QC','DASHBOARD','V'),
        ('INSTALL','DASHBOARD','V'),('SERVICE','DASHBOARD','V'),('FINANCE','DASHBOARD','VX'),('HR','DASHBOARD','V'),
    ('CEO','REPORTS','VX'),('ADMIN','REPORTS','VX'),('SALES','REPORTS','VX'),('PURCHASE','REPORTS','VX'),
        ('STORES','REPORTS','VX'),('PRODUCTION','REPORTS','VX'),('PLANNING','REPORTS','VX'),('QC','REPORTS','VX'),
        ('INSTALL','REPORTS','VX'),('SERVICE','REPORTS','VX'),('FINANCE','REPORTS','VX'),('HR','REPORTS','VX'),
    -- ---- Security / admin ----
    ('CEO','USER_MGMT','V'),('ADMIN','USER_MGMT','VCEDAX'),
    ('CEO','ROLE_MGMT','V'),('ADMIN','ROLE_MGMT','VCEDAX'),
    ('CEO','APPROVAL_CONFIG','VA'),('ADMIN','APPROVAL_CONFIG','VCEDX'),('FINANCE','APPROVAL_CONFIG','V'),
    ('CEO','AUDIT_LOG','VX'),('ADMIN','AUDIT_LOG','VX'),('QC','AUDIT_LOG','V'),('FINANCE','AUDIT_LOG','VX'),('HR','AUDIT_LOG','V'),
    ('CEO','SYSTEM_CONFIG','V'),('ADMIN','SYSTEM_CONFIG','VCEDX'),('FINANCE','SYSTEM_CONFIG','V')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 8.4 Segregation-of-Duties rules (enforced per USER by the app/approval engine)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sec.sod_conflict (
    conflict_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    perm_a      VARCHAR(60) NOT NULL,
    perm_b      VARCHAR(60) NOT NULL,
    severity    VARCHAR(10) NOT NULL DEFAULT 'HIGH',
    description VARCHAR(200),
    CONSTRAINT uq_sod UNIQUE (perm_a, perm_b),
    CONSTRAINT ck_sod_sev CHECK (severity IN ('HIGH','MEDIUM','LOW'))
);

INSERT INTO sec.sod_conflict (perm_a, perm_b, severity, description) VALUES
 ('PURCHASE_ORDER.CREATE','PURCHASE_ORDER.APPROVE','HIGH','Buyer cannot approve own PO'),
 ('PURCHASE_REQ.CREATE','PURCHASE_REQ.APPROVE','HIGH','Requisitioner cannot approve own PR'),
 ('VENDOR.CREATE','PURCHASE_ORDER.APPROVE','HIGH','Vendor onboarder cannot approve POs to that vendor'),
 ('AP_INVOICE.CREATE','AP_INVOICE.APPROVE','HIGH','AP entry vs payment approval'),
 ('INVOICE.CREATE','INVOICE.APPROVE','HIGH','AR invoice raise vs approval'),
 ('INVENTORY.EDIT','INVENTORY.APPROVE','HIGH','Stock editor cannot approve own write-off'),
 ('TIMESHEET.CREATE','TIMESHEET.APPROVE','MEDIUM','Self-approval of timesheets'),
 ('GRN.CREATE','PURCHASE_ORDER.APPROVE','MEDIUM','Receiving vs PO approval'),
 ('USER_MGMT.CREATE','QUOTATION.APPROVE','HIGH','Admin must not hold business approval'),
 ('WORK_ORDER.CREATE','WORK_ORDER.APPROVE','MEDIUM','WO raise vs release approval')
ON CONFLICT (perm_a, perm_b) DO NOTHING;

-- Detects any USER who, via their combined roles, holds both sides of a conflict.
CREATE OR REPLACE VIEW sec.v_user_sod_violations AS
SELECT u.user_id, u.username, s.perm_a, s.perm_b, s.severity
FROM sec.sod_conflict s
JOIN sec.app_user u ON true
WHERE EXISTS (
    SELECT 1 FROM sec.user_role ur JOIN sec.role_permission rp ON rp.role_id = ur.role_id
    JOIN sec.permission p ON p.permission_id = rp.permission_id
    WHERE ur.user_id = u.user_id AND p.perm_code = s.perm_a)
  AND EXISTS (
    SELECT 1 FROM sec.user_role ur JOIN sec.role_permission rp ON rp.role_id = ur.role_id
    JOIN sec.permission p ON p.permission_id = rp.permission_id
    WHERE ur.user_id = u.user_id AND p.perm_code = s.perm_b);

-- Convenience: effective permissions per role (reporting/audit)
CREATE OR REPLACE VIEW sec.v_role_permission AS
SELECT r.role_code, p.module, p.action, p.perm_code
FROM sec.role r
JOIN sec.role_permission rp ON rp.role_id = r.role_id
JOIN sec.permission p ON p.permission_id = rp.permission_id;

GRANT SELECT ON sec.v_user_sod_violations, sec.v_role_permission TO erp_app, erp_readonly;

-- End Part 8 -- RBAC.
