-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 3/6 : HCM + PRODUCTION + SUPPLY CHAIN
-- Modules: M07 Employee Workload, M08 Production, M05 Procurement, M06 Inventory
-- Order: hcm -> mfg -> scm  (so scm.material_issue can reference mfg.work_order)
-- =====================================================================

-- =====================================================================
-- HCM (hcm)  -- M07
-- =====================================================================

CREATE TABLE hcm.department (
    department_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    dept_code     VARCHAR(20) NOT NULL,
    dept_name     VARCHAR(80) NOT NULL,
    CONSTRAINT uq_dept UNIQUE (company_id, dept_code)
);

CREATE TABLE hcm.designation (
    designation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    desig_code     VARCHAR(20) NOT NULL UNIQUE,
    desig_name     VARCHAR(80) NOT NULL
);

CREATE TABLE hcm.employee (
    employee_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    emp_code       VARCHAR(20) NOT NULL UNIQUE,
    full_name      VARCHAR(120) NOT NULL,
    department_id  BIGINT REFERENCES hcm.department(department_id),
    designation_id BIGINT REFERENCES hcm.designation(designation_id),
    bu_id          BIGINT REFERENCES mdm.business_unit(bu_id),
    cost_rate      NUMERIC(20,6) NOT NULL DEFAULT 0,   -- per hour, feeds project cost
    billing_rate   NUMERIC(20,6) NOT NULL DEFAULT 0,
    doj            DATE,
    status         VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_emp_status CHECK (status IN ('ACTIVE','INACTIVE','LEFT'))
);
CREATE INDEX ix_employee_dept ON hcm.employee(department_id);

CREATE TABLE hcm.skill (
    skill_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    skill_code VARCHAR(20) NOT NULL UNIQUE,
    skill_name VARCHAR(80) NOT NULL
);

CREATE TABLE hcm.employee_skill (
    employee_id BIGINT NOT NULL REFERENCES hcm.employee(employee_id) ON DELETE CASCADE,
    skill_id    BIGINT NOT NULL REFERENCES hcm.skill(skill_id),
    proficiency SMALLINT CHECK (proficiency BETWEEN 1 AND 5),
    PRIMARY KEY (employee_id, skill_id)
);

CREATE TABLE hcm.capacity_calendar (
    cal_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES hcm.employee(employee_id) ON DELETE CASCADE,
    cal_date      DATE NOT NULL,
    available_hours NUMERIC(6,2) NOT NULL DEFAULT 8,
    is_holiday    BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_capacity UNIQUE (employee_id, cal_date)
);
CREATE INDEX ix_capacity_date ON hcm.capacity_calendar(cal_date);

CREATE TABLE hcm.leave (
    leave_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id BIGINT NOT NULL REFERENCES hcm.employee(employee_id) ON DELETE CASCADE,
    from_date   DATE NOT NULL,
    to_date     DATE NOT NULL,
    leave_type  VARCHAR(20),
    status      VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    CONSTRAINT ck_leave_dates CHECK (to_date >= from_date),
    CONSTRAINT ck_leave_status CHECK (status IN ('PENDING','APPROVED','REJECTED'))
);
CREATE INDEX ix_leave_emp ON hcm.leave(employee_id, from_date);

CREATE TABLE hcm.resource_allocation (
    alloc_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id   BIGINT NOT NULL REFERENCES hcm.employee(employee_id),
    project_id    BIGINT NOT NULL REFERENCES proj.project(project_id),
    task_id       BIGINT REFERENCES proj.task(task_id),
    alloc_date    DATE NOT NULL,
    planned_hours NUMERIC(6,2) NOT NULL DEFAULT 0,
    status        VARCHAR(15) NOT NULL DEFAULT 'PLANNED',
    CONSTRAINT uq_alloc UNIQUE (employee_id, task_id, alloc_date),
    CONSTRAINT ck_alloc_status CHECK (status IN ('PLANNED','CONFIRMED','CANCELLED'))
);
CREATE INDEX ix_alloc_project ON hcm.resource_allocation(project_id);
CREATE INDEX ix_alloc_emp_date ON hcm.resource_allocation(employee_id, alloc_date);

CREATE TABLE hcm.timesheet (
    ts_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id  BIGINT NOT NULL REFERENCES hcm.employee(employee_id),
    period_start DATE NOT NULL,
    period_end   DATE NOT NULL,
    status       VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    submitted_at TIMESTAMPTZ,
    approved_by  BIGINT REFERENCES sec.app_user(user_id),
    approved_at  TIMESTAMPTZ,
    CONSTRAINT ck_ts_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
    CONSTRAINT ck_ts_period CHECK (period_end >= period_start)
);
CREATE INDEX ix_ts_emp ON hcm.timesheet(employee_id, period_start);

CREATE TABLE hcm.timesheet_line (
    ts_line_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timesheet_id BIGINT NOT NULL REFERENCES hcm.timesheet(ts_id) ON DELETE CASCADE,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
    wbs_id       BIGINT REFERENCES proj.wbs_element(wbs_id),
    work_date    DATE NOT NULL,
    hours        NUMERIC(6,2) NOT NULL,
    cost_amount  NUMERIC(20,4) NOT NULL DEFAULT 0,    -- hours * cost_rate -> M15
    CONSTRAINT ck_ts_hours CHECK (hours > 0 AND hours <= 24)
);
CREATE INDEX ix_ts_line_project ON hcm.timesheet_line(project_id, work_date);
CREATE INDEX ix_ts_line_ts ON hcm.timesheet_line(timesheet_id);

-- =====================================================================
-- PRODUCTION (mfg)  -- M08
-- =====================================================================

CREATE TABLE mfg.work_order (
    wo_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    wo_no         VARCHAR(30) NOT NULL UNIQUE,
    project_id    BIGINT NOT NULL REFERENCES proj.project(project_id),
    wbs_id        BIGINT REFERENCES proj.wbs_element(wbs_id),
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    bom_id        BIGINT REFERENCES mdm.bom_header(bom_id),
    routing_id    BIGINT REFERENCES mdm.routing(routing_id),
    qty           NUMERIC(20,4) NOT NULL,
    planned_start DATE,
    planned_end   DATE,
    actual_start  DATE,
    actual_end    DATE,
    status        VARCHAR(15) NOT NULL DEFAULT 'PLANNED',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_wo_status CHECK (status IN ('PLANNED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED'))
);
CREATE INDEX ix_wo_project ON mfg.work_order(project_id);
CREATE INDEX ix_wo_status  ON mfg.work_order(status);
CREATE INDEX ix_wo_item    ON mfg.work_order(item_id);

CREATE TABLE mfg.work_order_operation (
    wo_op_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wo_id          BIGINT NOT NULL REFERENCES mfg.work_order(wo_id) ON DELETE CASCADE,
    op_seq         SMALLINT NOT NULL,
    work_center_id BIGINT NOT NULL REFERENCES mdm.work_center(wc_id),
    std_time_min   NUMERIC(12,2) NOT NULL DEFAULT 0,
    actual_time_min NUMERIC(12,2) NOT NULL DEFAULT 0,
    status         VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    CONSTRAINT uq_wo_op UNIQUE (wo_id, op_seq),
    CONSTRAINT ck_wo_op_status CHECK (status IN ('PENDING','IN_PROGRESS','DONE'))
);
CREATE INDEX ix_wo_op_wo ON mfg.work_order_operation(wo_id);
CREATE INDEX ix_wo_op_wc ON mfg.work_order_operation(work_center_id);

CREATE TABLE mfg.work_order_material (
    wo_mat_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wo_id        BIGINT NOT NULL REFERENCES mfg.work_order(wo_id) ON DELETE CASCADE,
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    required_qty NUMERIC(20,4) NOT NULL,
    issued_qty   NUMERIC(20,4) NOT NULL DEFAULT 0
);
CREATE INDEX ix_wo_mat_wo ON mfg.work_order_material(wo_id);
CREATE INDEX ix_wo_mat_item ON mfg.work_order_material(item_id);

CREATE TABLE mfg.production_confirmation (
    conf_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wo_op_id     BIGINT NOT NULL REFERENCES mfg.work_order_operation(wo_op_id),
    qty_done     NUMERIC(20,4) NOT NULL DEFAULT 0,
    qty_scrap    NUMERIC(20,4) NOT NULL DEFAULT 0,
    labour_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
    conf_date    DATE NOT NULL DEFAULT current_date,
    confirmed_by BIGINT REFERENCES sec.app_user(user_id),
    scrap_reason_id BIGINT REFERENCES mdm.reason_code(reason_id)
);
CREATE INDEX ix_conf_wo_op ON mfg.production_confirmation(wo_op_id);
CREATE INDEX ix_conf_date  ON mfg.production_confirmation(conf_date);

CREATE TABLE mfg.as_built (
    as_built_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wo_id            BIGINT NOT NULL REFERENCES mfg.work_order(wo_id),
    serial_id        BIGINT,                 -- FK -> scm.serial_number (deferred; created below)
    parent_serial_id BIGINT,                 -- self/serial genealogy (deferred)
    built_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_as_built_wo ON mfg.as_built(wo_id);

-- =====================================================================
-- SUPPLY CHAIN (scm)  -- M05 Procurement, M06 Inventory
-- =====================================================================

CREATE TABLE scm.purchase_requisition (
    pr_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    pr_no         VARCHAR(30) NOT NULL UNIQUE,
    project_id    BIGINT REFERENCES proj.project(project_id),
    wbs_id        BIGINT REFERENCES proj.wbs_element(wbs_id),
    required_date DATE,
    status        VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_pr_status CHECK (status IN ('DRAFT','PENDING','APPROVED','PO_CREATED','CANCELLED'))
);
CREATE INDEX ix_pr_project ON scm.purchase_requisition(project_id);
CREATE INDEX ix_pr_status  ON scm.purchase_requisition(status);

CREATE TABLE scm.pr_line (
    pr_line_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pr_id         BIGINT NOT NULL REFERENCES scm.purchase_requisition(pr_id) ON DELETE CASCADE,
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty           NUMERIC(20,4) NOT NULL,
    uom_id        BIGINT NOT NULL REFERENCES mdm.uom(uom_id),
    required_date DATE
);
CREATE INDEX ix_pr_line_item ON scm.pr_line(item_id);

CREATE TABLE scm.rfq (
    rfq_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    rfq_no     VARCHAR(30) NOT NULL UNIQUE,
    pr_id      BIGINT REFERENCES scm.purchase_requisition(pr_id),
    rfq_date   DATE NOT NULL DEFAULT current_date,
    status     VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT ck_rfq_status CHECK (status IN ('OPEN','QUOTED','CLOSED','CANCELLED'))
);

CREATE TABLE scm.rfq_vendor (
    rfq_vendor_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rfq_id        BIGINT NOT NULL REFERENCES scm.rfq(rfq_id) ON DELETE CASCADE,
    vendor_id     BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    CONSTRAINT uq_rfq_vendor UNIQUE (rfq_id, vendor_id)
);
CREATE INDEX ix_rfq_vendor_v ON scm.rfq_vendor(vendor_id);

CREATE TABLE scm.vendor_quote (
    vendor_quote_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rfq_id          BIGINT NOT NULL REFERENCES scm.rfq(rfq_id),
    vendor_id       BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    quote_date      DATE NOT NULL DEFAULT current_date,
    total_amount    NUMERIC(20,4) NOT NULL DEFAULT 0,
    lead_time_days  INT,
    is_selected     BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_vendor_quote UNIQUE (rfq_id, vendor_id)
);
CREATE INDEX ix_vquote_vendor ON scm.vendor_quote(vendor_id);

CREATE TABLE scm.vendor_quote_line (
    vq_line_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_quote_id BIGINT NOT NULL REFERENCES scm.vendor_quote(vendor_quote_id) ON DELETE CASCADE,
    item_id         BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty             NUMERIC(20,4) NOT NULL,
    unit_rate       NUMERIC(20,6) NOT NULL
);

CREATE TABLE scm.purchase_order (
    po_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    po_no         VARCHAR(30) NOT NULL UNIQUE,
    vendor_id     BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    project_id    BIGINT REFERENCES proj.project(project_id),    -- project-pegged
    po_date       DATE NOT NULL DEFAULT current_date,
    currency_id   BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    total_amount  NUMERIC(20,4) NOT NULL DEFAULT 0,
    expected_date DATE,
    status        VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_po_status CHECK (status IN ('DRAFT','PENDING','APPROVED','PARTIAL','RECEIVED','CLOSED','CANCELLED'))
);
CREATE INDEX ix_po_vendor  ON scm.purchase_order(vendor_id);
CREATE INDEX ix_po_project ON scm.purchase_order(project_id);
CREATE INDEX ix_po_status  ON scm.purchase_order(status, po_date);

CREATE TABLE scm.po_line (
    po_line_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_id        BIGINT NOT NULL REFERENCES scm.purchase_order(po_id) ON DELETE CASCADE,
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty          NUMERIC(20,4) NOT NULL,
    received_qty NUMERIC(20,4) NOT NULL DEFAULT 0,
    unit_rate    NUMERIC(20,6) NOT NULL,
    tax_code_id  BIGINT REFERENCES mdm.tax_code(tax_code_id),
    line_amount  NUMERIC(20,4) NOT NULL DEFAULT 0,
    need_by_date DATE
);
CREATE INDEX ix_po_line_po   ON scm.po_line(po_id);
CREATE INDEX ix_po_line_item ON scm.po_line(item_id);

CREATE TABLE scm.po_amendment (
    amendment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    po_id        BIGINT NOT NULL REFERENCES scm.purchase_order(po_id) ON DELETE CASCADE,
    amend_no     SMALLINT NOT NULL,
    reason       VARCHAR(300),
    amended_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    amended_by   BIGINT REFERENCES sec.app_user(user_id),
    CONSTRAINT uq_po_amend UNIQUE (po_id, amend_no)
);

CREATE TABLE scm.batch_lot (
    batch_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id    BIGINT NOT NULL REFERENCES mdm.item(item_id),
    batch_no   VARCHAR(40) NOT NULL,
    mfg_date   DATE,
    expiry_date DATE,
    CONSTRAINT uq_batch UNIQUE (item_id, batch_no)
);

CREATE TABLE scm.serial_number (
    serial_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id     BIGINT NOT NULL REFERENCES mdm.item(item_id),
    serial_no   VARCHAR(60) NOT NULL,
    project_id  BIGINT REFERENCES proj.project(project_id),
    status      VARCHAR(15) NOT NULL DEFAULT 'IN_STOCK',
    CONSTRAINT uq_serial UNIQUE (item_id, serial_no),
    CONSTRAINT ck_serial_status CHECK (status IN ('IN_STOCK','WIP','DISPATCHED','INSTALLED','SCRAPPED'))
);
CREATE INDEX ix_serial_project ON scm.serial_number(project_id);

-- now wire deferred as_built serial FKs
ALTER TABLE mfg.as_built
    ADD CONSTRAINT fk_as_built_serial FOREIGN KEY (serial_id) REFERENCES scm.serial_number(serial_id),
    ADD CONSTRAINT fk_as_built_parent FOREIGN KEY (parent_serial_id) REFERENCES scm.serial_number(serial_id);

CREATE TABLE scm.goods_receipt (
    grn_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    grn_no     VARCHAR(30) NOT NULL UNIQUE,
    po_id      BIGINT REFERENCES scm.purchase_order(po_id),
    vendor_id  BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    grn_date   DATE NOT NULL DEFAULT current_date,
    status     VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_grn_status CHECK (status IN ('DRAFT','POSTED','QC_PENDING','ACCEPTED','REJECTED'))
);
CREATE INDEX ix_grn_po   ON scm.goods_receipt(po_id);
CREATE INDEX ix_grn_date ON scm.goods_receipt(grn_date);

CREATE TABLE scm.grn_line (
    grn_line_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grn_id       BIGINT NOT NULL REFERENCES scm.goods_receipt(grn_id) ON DELETE CASCADE,
    po_line_id   BIGINT REFERENCES scm.po_line(po_line_id),
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    received_qty NUMERIC(20,4) NOT NULL,
    accepted_qty NUMERIC(20,4) NOT NULL DEFAULT 0,
    rejected_qty NUMERIC(20,4) NOT NULL DEFAULT 0,
    batch_id     BIGINT REFERENCES scm.batch_lot(batch_id),
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id)
);
CREATE INDEX ix_grn_line_grn  ON scm.grn_line(grn_id);
CREATE INDEX ix_grn_line_item ON scm.grn_line(item_id);

-- Current on-hand stock (one row per item/warehouse/bin/batch/project)
CREATE TABLE scm.item_stock (
    stock_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    bin_id       BIGINT REFERENCES mdm.storage_bin(bin_id),
    batch_id     BIGINT REFERENCES scm.batch_lot(batch_id),
    project_id   BIGINT REFERENCES proj.project(project_id),   -- project stock vs free stock
    qty_on_hand  NUMERIC(20,4) NOT NULL DEFAULT 0,
    qty_reserved NUMERIC(20,4) NOT NULL DEFAULT 0,
    qty_available NUMERIC(20,4) GENERATED ALWAYS AS (qty_on_hand - qty_reserved) STORED,
    avg_cost     NUMERIC(20,6) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_item_stock UNIQUE (item_id, warehouse_id, bin_id, batch_id, project_id)
);
CREATE INDEX ix_stock_item    ON scm.item_stock(item_id);
CREATE INDEX ix_stock_project ON scm.item_stock(project_id) WHERE project_id IS NOT NULL;

-- Immutable inventory ledger -- PARTITIONED BY RANGE (txn_date), monthly
CREATE TABLE scm.stock_transaction (
    txn_id       BIGINT GENERATED ALWAYS AS IDENTITY,
    txn_date     TIMESTAMPTZ NOT NULL DEFAULT now(),
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    txn_type     VARCHAR(15) NOT NULL,
    qty          NUMERIC(20,4) NOT NULL,           -- signed
    unit_cost    NUMERIC(20,6) NOT NULL DEFAULT 0,
    project_id   BIGINT REFERENCES proj.project(project_id),
    ref_doc_type VARCHAR(20) NOT NULL,
    ref_doc_id   BIGINT NOT NULL,
    created_by   BIGINT REFERENCES sec.app_user(user_id),
    CONSTRAINT pk_stock_txn PRIMARY KEY (txn_id, txn_date),
    CONSTRAINT ck_stock_txn_type CHECK (txn_type IN ('GRN','ISSUE','RETURN','ADJUST','TRANSFER','RESERVE'))
) PARTITION BY RANGE (txn_date);
-- default partition catches stray rows; rolling monthly partitions added in 06_*
CREATE TABLE scm.stock_transaction_default PARTITION OF scm.stock_transaction DEFAULT;
CREATE INDEX ix_stock_txn_item    ON scm.stock_transaction(item_id, txn_date);
CREATE INDEX ix_stock_txn_project ON scm.stock_transaction(project_id);
CREATE INDEX ix_stock_txn_ref     ON scm.stock_transaction(ref_doc_type, ref_doc_id);

CREATE TABLE scm.material_reservation (
    reservation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id     BIGINT NOT NULL REFERENCES proj.project(project_id),
    wbs_id         BIGINT REFERENCES proj.wbs_element(wbs_id),
    reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    status         VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT ck_resv_status CHECK (status IN ('OPEN','PARTIAL','FULFILLED','CANCELLED'))
);
CREATE INDEX ix_resv_project ON scm.material_reservation(project_id);

CREATE TABLE scm.reservation_line (
    resv_line_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reservation_id BIGINT NOT NULL REFERENCES scm.material_reservation(reservation_id) ON DELETE CASCADE,
    item_id        BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty            NUMERIC(20,4) NOT NULL,
    warehouse_id   BIGINT REFERENCES mdm.warehouse(warehouse_id)
);
CREATE INDEX ix_resv_line_item ON scm.reservation_line(item_id);

CREATE TABLE scm.material_issue (
    issue_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    issue_no   VARCHAR(30) NOT NULL UNIQUE,
    project_id BIGINT NOT NULL REFERENCES proj.project(project_id),
    wo_id      BIGINT REFERENCES mfg.work_order(wo_id),
    issue_date DATE NOT NULL DEFAULT current_date,
    created_by BIGINT REFERENCES sec.app_user(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_issue_project ON scm.material_issue(project_id);
CREATE INDEX ix_issue_wo      ON scm.material_issue(wo_id);

CREATE TABLE scm.material_issue_line (
    issue_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    issue_id      BIGINT NOT NULL REFERENCES scm.material_issue(issue_id) ON DELETE CASCADE,
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty           NUMERIC(20,4) NOT NULL,
    warehouse_id  BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    batch_id      BIGINT REFERENCES scm.batch_lot(batch_id),
    unit_cost     NUMERIC(20,6) NOT NULL DEFAULT 0
);
CREATE INDEX ix_issue_line_item ON scm.material_issue_line(item_id);

-- Critical items -- M06 heartbeat
CREATE TABLE scm.critical_item (
    crit_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    project_id    BIGINT NOT NULL REFERENCES proj.project(project_id),
    reason        VARCHAR(15) NOT NULL,
    order_by_date DATE,
    status        VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT uq_crit UNIQUE (item_id, project_id),
    CONSTRAINT ck_crit_reason CHECK (reason IN ('LONG_LEAD','SINGLE_SOURCE','HIGH_VALUE','IMPORT')),
    CONSTRAINT ck_crit_status CHECK (status IN ('OPEN','ORDERED','RECEIVED','AT_RISK'))
);
CREATE INDEX ix_crit_status ON scm.critical_item(status, order_by_date);

CREATE TABLE scm.critical_item_alert (
    alert_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    crit_id     BIGINT NOT NULL REFERENCES scm.critical_item(crit_id) ON DELETE CASCADE,
    alert_date  DATE NOT NULL DEFAULT current_date,
    severity    VARCHAR(10),
    message     VARCHAR(300),
    acknowledged_by BIGINT REFERENCES sec.app_user(user_id)
);
CREATE INDEX ix_crit_alert ON scm.critical_item_alert(crit_id);

-- Subcontracting / job-work
CREATE TABLE scm.subcontract_order (
    sco_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    sco_no     VARCHAR(30) NOT NULL UNIQUE,
    vendor_id  BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    project_id BIGINT REFERENCES proj.project(project_id),
    sco_date   DATE NOT NULL DEFAULT current_date,
    status     VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT ck_sco_status CHECK (status IN ('OPEN','MATERIAL_ISSUED','RECEIVED','CLOSED'))
);
CREATE INDEX ix_sco_vendor ON scm.subcontract_order(vendor_id);

CREATE TABLE scm.subcontract_issue (
    sci_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sco_id   BIGINT NOT NULL REFERENCES scm.subcontract_order(sco_id) ON DELETE CASCADE,
    item_id  BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty      NUMERIC(20,4) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scm.subcontract_receipt (
    scr_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sco_id   BIGINT NOT NULL REFERENCES scm.subcontract_order(sco_id) ON DELETE CASCADE,
    item_id  BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty      NUMERIC(20,4) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scm.stock_count (
    count_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    count_no   VARCHAR(30) NOT NULL UNIQUE,
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    count_date DATE NOT NULL DEFAULT current_date,
    count_type VARCHAR(15) NOT NULL DEFAULT 'CYCLE',
    status     VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT ck_count_type CHECK (count_type IN ('CYCLE','PHYSICAL')),
    CONSTRAINT ck_count_status CHECK (status IN ('OPEN','COUNTED','RECONCILED','CLOSED'))
);

CREATE TABLE scm.stock_count_line (
    count_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    count_id      BIGINT NOT NULL REFERENCES scm.stock_count(count_id) ON DELETE CASCADE,
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    system_qty    NUMERIC(20,4) NOT NULL DEFAULT 0,
    counted_qty   NUMERIC(20,4),
    variance_qty  NUMERIC(20,4) GENERATED ALWAYS AS (counted_qty - system_qty) STORED
);
CREATE INDEX ix_count_line_item ON scm.stock_count_line(item_id);

-- End Part 3/6
