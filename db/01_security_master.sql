-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 1/6 : SECURITY + MASTER DATA
-- Target: PostgreSQL 15+
-- Run order: 01 -> 02 -> 03 -> 04 -> 05 -> 06 (06 adds deferred cross-schema FKs)
-- Convention: BIGINT identity PK, *_no/*_code business key, NUMERIC money,
--   TIMESTAMPTZ (UTC), soft-delete + row_version, all FKs indexed.
-- Forward references (to tables created in later parts) are added in 06_*.
-- =====================================================================

-- ---------- Extensions ----------
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- trigram search (item/customer names)
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- composite GIN
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- hashing / gen_random_uuid

-- ---------- Schemas (namespaces) ----------
CREATE SCHEMA IF NOT EXISTS sec;     -- security, RBAC, approval engine
CREATE SCHEMA IF NOT EXISTS mdm;     -- master data (incl. BOM, GL, work centers)
CREATE SCHEMA IF NOT EXISTS sales;   -- enquiry, quotation, CRM
CREATE SCHEMA IF NOT EXISTS proj;    -- project, WBS, planning, change, forecast
CREATE SCHEMA IF NOT EXISTS scm;     -- procurement, inventory, critical items
CREATE SCHEMA IF NOT EXISTS hcm;     -- employee, capacity, timesheets
CREATE SCHEMA IF NOT EXISTS mfg;     -- production, work orders, as-built
CREATE SCHEMA IF NOT EXISTS qms;     -- FAT, inspection, NCR, RCA, CAPA
CREATE SCHEMA IF NOT EXISTS log;     -- dispatch, shipment, e-way bill
CREATE SCHEMA IF NOT EXISTS svc;     -- installation, warranty, service
CREATE SCHEMA IF NOT EXISTS fin;     -- billing, tax, cost ledger, profitability
CREATE SCHEMA IF NOT EXISTS audit;   -- change/login/approval audit (partitioned)
CREATE SCHEMA IF NOT EXISTS rpt;     -- star schema + materialized views

-- =====================================================================
-- SECURITY (sec)
-- =====================================================================

-- app_user is created first because every table's audit columns FK to it.
-- employee_id FK -> hcm.employee is deferred to 06_* (forward reference).
CREATE TABLE sec.app_user (
    user_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username       VARCHAR(60)  NOT NULL UNIQUE,
    email          VARCHAR(120) NOT NULL UNIQUE,
    full_name      VARCHAR(120) NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    employee_id    BIGINT,                       -- FK -> hcm.employee (deferred)
    is_active      BOOLEAN      NOT NULL DEFAULT true,
    mfa_enabled    BOOLEAN      NOT NULL DEFAULT false,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by     BIGINT,                        -- self-referential, set in app/seed
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by     BIGINT,
    row_version    INT          NOT NULL DEFAULT 1,
    is_deleted     BOOLEAN      NOT NULL DEFAULT false
);
ALTER TABLE sec.app_user
    ADD CONSTRAINT fk_app_user_created_by FOREIGN KEY (created_by) REFERENCES sec.app_user(user_id),
    ADD CONSTRAINT fk_app_user_updated_by FOREIGN KEY (updated_by) REFERENCES sec.app_user(user_id);
CREATE INDEX ix_app_user_employee ON sec.app_user(employee_id);

CREATE TABLE sec.role (
    role_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_code   VARCHAR(40)  NOT NULL UNIQUE,
    role_name   VARCHAR(80)  NOT NULL,
    description VARCHAR(255),
    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT          NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN      NOT NULL DEFAULT false
);

CREATE TABLE sec.permission (
    permission_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    perm_code     VARCHAR(60) NOT NULL UNIQUE,   -- e.g. 'PO.APPROVE'
    module        VARCHAR(30) NOT NULL,
    action        VARCHAR(30) NOT NULL,
    description   VARCHAR(255)
);

CREATE TABLE sec.user_role (
    user_id BIGINT NOT NULL REFERENCES sec.app_user(user_id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES sec.role(role_id)     ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX ix_user_role_role ON sec.user_role(role_id);

CREATE TABLE sec.role_permission (
    role_id       BIGINT NOT NULL REFERENCES sec.role(role_id)             ON DELETE CASCADE,
    permission_id BIGINT NOT NULL REFERENCES sec.permission(permission_id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX ix_role_perm_perm ON sec.role_permission(permission_id);

-- Delegation of Authority: drives value-based approval routing (FRD A1-A17)
CREATE TABLE sec.delegation_of_authority (
    doa_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT       NOT NULL,         -- FK -> mdm.company (added below)
    doc_type       VARCHAR(30)  NOT NULL,
    role_id        BIGINT       NOT NULL REFERENCES sec.role(role_id),
    min_amount     NUMERIC(20,4) NOT NULL DEFAULT 0,
    max_amount     NUMERIC(20,4),                 -- NULL = unlimited
    approval_level SMALLINT     NOT NULL,
    is_active      BOOLEAN      NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by     BIGINT REFERENCES sec.app_user(user_id),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_by     BIGINT REFERENCES sec.app_user(user_id),
    row_version    INT          NOT NULL DEFAULT 1,
    is_deleted     BOOLEAN      NOT NULL DEFAULT false,
    CONSTRAINT ck_doa_doc_type CHECK (doc_type IN
        ('QUOTE','PR','PO','PROJECT_BUDGET','CHANGE_ORDER','STOCK_ADJUST',
         'TIMESHEET','WORK_ORDER','DISPATCH','SAT','WARRANTY_CLAIM','CAPA','PROJECT_CLOSE'))
);
CREATE INDEX ix_doa_doctype_level ON sec.delegation_of_authority(doc_type, approval_level);

-- Generic approval engine: one engine routes every approvable document.
CREATE TABLE sec.approval_request (
    approval_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type      VARCHAR(30) NOT NULL,
    doc_id        BIGINT      NOT NULL,
    current_level SMALLINT    NOT NULL DEFAULT 1,
    status        VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    requested_by  BIGINT      NOT NULL REFERENCES sec.app_user(user_id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    CONSTRAINT ck_appr_status CHECK (status IN ('PENDING','APPROVED','REJECTED','ESCALATED'))
);
CREATE UNIQUE INDEX uq_appr_open ON sec.approval_request(doc_type, doc_id)
    WHERE status = 'PENDING';
CREATE INDEX ix_appr_status ON sec.approval_request(status, doc_type);

CREATE TABLE sec.approval_action (
    action_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    approval_id  BIGINT      NOT NULL REFERENCES sec.approval_request(approval_id) ON DELETE CASCADE,
    approver_id  BIGINT      NOT NULL REFERENCES sec.app_user(user_id),
    level        SMALLINT    NOT NULL,
    action       VARCHAR(10) NOT NULL,
    remarks      VARCHAR(500),
    acted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_appr_action CHECK (action IN ('APPROVE','REJECT','RETURN'))
);
CREATE INDEX ix_appr_action_req ON sec.approval_action(approval_id);

-- =====================================================================
-- MASTER DATA (mdm)
-- =====================================================================

CREATE TABLE mdm.currency (
    currency_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    iso_code    CHAR(3)     NOT NULL UNIQUE,
    name        VARCHAR(60) NOT NULL,
    symbol      VARCHAR(6),
    is_active   BOOLEAN     NOT NULL DEFAULT true
);

CREATE TABLE mdm.company (
    company_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_code            VARCHAR(10)  NOT NULL UNIQUE,
    legal_name              VARCHAR(150) NOT NULL,
    gstin                   VARCHAR(15),
    pan                     VARCHAR(10),
    base_currency_id        BIGINT       NOT NULL REFERENCES mdm.currency(currency_id),
    fiscal_year_start_month SMALLINT     NOT NULL DEFAULT 4,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_company_fy_month CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
    CONSTRAINT ck_company_gstin CHECK (gstin IS NULL OR char_length(gstin) = 15)
);

-- now that mdm.company exists, wire the deferred DOA company FK
ALTER TABLE sec.delegation_of_authority
    ADD CONSTRAINT fk_doa_company FOREIGN KEY (company_id) REFERENCES mdm.company(company_id);

CREATE TABLE mdm.exchange_rate (
    rate_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_ccy_id  BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    to_ccy_id    BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    rate_date    DATE   NOT NULL,
    rate         NUMERIC(20,6) NOT NULL CHECK (rate > 0),
    CONSTRAINT uq_fx UNIQUE (from_ccy_id, to_ccy_id, rate_date)
);
CREATE INDEX ix_fx_date ON mdm.exchange_rate(rate_date);

CREATE TABLE mdm.business_unit (
    bu_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_code    VARCHAR(15) NOT NULL,
    bu_name    VARCHAR(100) NOT NULL,
    bu_type    VARCHAR(15) NOT NULL DEFAULT 'PLANT',
    is_active  BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_bu UNIQUE (company_id, bu_code),
    CONSTRAINT ck_bu_type CHECK (bu_type IN ('PLANT','BRANCH','OFFICE'))
);

CREATE TABLE mdm.warehouse (
    warehouse_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bu_id        BIGINT NOT NULL REFERENCES mdm.business_unit(bu_id),
    wh_code      VARCHAR(15) NOT NULL,
    wh_name      VARCHAR(100) NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_wh UNIQUE (bu_id, wh_code)
);

CREATE TABLE mdm.storage_bin (
    bin_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    bin_code     VARCHAR(20) NOT NULL,
    CONSTRAINT uq_bin UNIQUE (warehouse_id, bin_code)
);

CREATE TABLE mdm.uom (
    uom_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uom_code VARCHAR(10) NOT NULL UNIQUE,
    uom_name VARCHAR(40) NOT NULL
);

CREATE TABLE mdm.uom_conversion (
    conv_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_uom_id BIGINT NOT NULL REFERENCES mdm.uom(uom_id),
    to_uom_id   BIGINT NOT NULL REFERENCES mdm.uom(uom_id),
    factor      NUMERIC(20,6) NOT NULL CHECK (factor > 0),
    CONSTRAINT uq_uom_conv UNIQUE (from_uom_id, to_uom_id)
);

CREATE TABLE mdm.item_category (
    category_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cat_code    VARCHAR(20) NOT NULL UNIQUE,
    cat_name    VARCHAR(80) NOT NULL,
    parent_id   BIGINT REFERENCES mdm.item_category(category_id)
);
CREATE INDEX ix_item_cat_parent ON mdm.item_category(parent_id);

CREATE TABLE mdm.hsn_sac (
    hsn_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hsn_code  VARCHAR(10) NOT NULL UNIQUE,
    description VARCHAR(150),
    gst_rate  NUMERIC(9,4) NOT NULL DEFAULT 0
);

CREATE TABLE mdm.tax_code (
    tax_code_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        VARCHAR(20) NOT NULL UNIQUE,
    cgst_rate   NUMERIC(9,4) NOT NULL DEFAULT 0,
    sgst_rate   NUMERIC(9,4) NOT NULL DEFAULT 0,
    igst_rate   NUMERIC(9,4) NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE mdm.payment_term (
    term_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    term_code     VARCHAR(20) NOT NULL UNIQUE,
    term_name     VARCHAR(80) NOT NULL,
    net_days      INT NOT NULL DEFAULT 0,
    milestone_json JSONB        -- optional milestone breakdown for advances/retention
);

CREATE TABLE mdm.incoterm (
    incoterm_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        VARCHAR(10) NOT NULL UNIQUE,
    description VARCHAR(100)
);

CREATE TABLE mdm.gl_account (   -- Chart of Accounts (FRD gap-fill, finance foundation)
    gl_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    gl_code      VARCHAR(20) NOT NULL,
    gl_name      VARCHAR(120) NOT NULL,
    account_type VARCHAR(15) NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_gl UNIQUE (company_id, gl_code),
    CONSTRAINT ck_gl_type CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE'))
);

CREATE TABLE mdm.cost_center (
    cc_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    cc_code   VARCHAR(20) NOT NULL,
    cc_name   VARCHAR(80) NOT NULL,
    CONSTRAINT uq_cc UNIQUE (company_id, cc_code)
);

CREATE TABLE mdm.work_center (   -- production capacity (M08)
    wc_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bu_id        BIGINT NOT NULL REFERENCES mdm.business_unit(bu_id),
    wc_code      VARCHAR(20) NOT NULL UNIQUE,
    wc_name      VARCHAR(80) NOT NULL,
    capacity_per_day NUMERIC(20,4) NOT NULL DEFAULT 0,
    cost_rate    NUMERIC(20,6) NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE mdm.numbering_series (
    series_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    doc_type   VARCHAR(30) NOT NULL,
    prefix     VARCHAR(15) NOT NULL,
    fy         VARCHAR(9)  NOT NULL,        -- e.g. '2026-27'
    next_no    BIGINT NOT NULL DEFAULT 1,
    pad_width  SMALLINT NOT NULL DEFAULT 6,
    CONSTRAINT uq_numbering UNIQUE (company_id, doc_type, fy)
);

CREATE TABLE mdm.reason_code (
    reason_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reason_type VARCHAR(20) NOT NULL,   -- LOST, SCRAP, REWORK, ADJUST, HOLD
    code        VARCHAR(20) NOT NULL,
    description VARCHAR(120) NOT NULL,
    CONSTRAINT uq_reason UNIQUE (reason_type, code)
);
CREATE INDEX ix_reason_type ON mdm.reason_code(reason_type);

CREATE TABLE mdm.status_master (   -- optional configurable statuses
    status_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity    VARCHAR(40) NOT NULL,
    code      VARCHAR(20) NOT NULL,
    label     VARCHAR(60) NOT NULL,
    sort_order SMALLINT NOT NULL DEFAULT 0,
    is_terminal BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_status UNIQUE (entity, code)
);

-- ---------- Customer (M01) ----------
CREATE TABLE mdm.customer (
    customer_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id         BIGINT NOT NULL REFERENCES mdm.company(company_id),
    customer_code      VARCHAR(20) NOT NULL UNIQUE,
    customer_name      VARCHAR(150) NOT NULL,
    customer_type      VARCHAR(20) NOT NULL DEFAULT 'OTHER',
    gstin              VARCHAR(15),
    pan                VARCHAR(10),
    credit_limit       NUMERIC(20,4) NOT NULL DEFAULT 0,
    payment_term_id    BIGINT REFERENCES mdm.payment_term(term_id),
    default_currency_id BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    status             VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_cust_type CHECK (customer_type IN ('OEM','EPC','GOVT','DEALER','OTHER')),
    CONSTRAINT ck_cust_status CHECK (status IN ('ACTIVE','HOLD','BLOCKED'))
);
CREATE INDEX ix_customer_name ON mdm.customer USING gin (customer_name gin_trgm_ops);
CREATE INDEX ix_customer_gstin ON mdm.customer(gstin);
CREATE INDEX ix_customer_status ON mdm.customer(status) WHERE is_deleted = false;

CREATE TABLE mdm.customer_contact (
    contact_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES mdm.customer(customer_id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    designation VARCHAR(60),
    email       VARCHAR(120),
    phone       VARCHAR(30),
    is_primary  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_cust_contact ON mdm.customer_contact(customer_id);

CREATE TABLE mdm.customer_address (
    address_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id  BIGINT NOT NULL REFERENCES mdm.customer(customer_id) ON DELETE CASCADE,
    address_type VARCHAR(10) NOT NULL,
    line1        VARCHAR(150) NOT NULL,
    line2        VARCHAR(150),
    city         VARCHAR(60),
    state        VARCHAR(60),
    state_code   VARCHAR(4),     -- GST state code
    pincode      VARCHAR(10),
    country      VARCHAR(60) NOT NULL DEFAULT 'India',
    CONSTRAINT ck_cust_addr_type CHECK (address_type IN ('BILL_TO','SHIP_TO','BOTH'))
);
CREATE INDEX ix_cust_addr ON mdm.customer_address(customer_id);

-- ---------- Vendor (M05) ----------
CREATE TABLE mdm.vendor (
    vendor_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    vendor_code     VARCHAR(20) NOT NULL UNIQUE,
    vendor_name     VARCHAR(150) NOT NULL,
    gstin           VARCHAR(15),
    pan             VARCHAR(10),
    msme_flag       BOOLEAN NOT NULL DEFAULT false,
    is_approved     BOOLEAN NOT NULL DEFAULT false,   -- gates PO issue (A7)
    payment_term_id BIGINT REFERENCES mdm.payment_term(term_id),
    rating          NUMERIC(4,2) CHECK (rating BETWEEN 0 AND 5),
    status          VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_vendor_status CHECK (status IN ('ACTIVE','HOLD','BLACKLISTED'))
);
CREATE INDEX ix_vendor_name ON mdm.vendor USING gin (vendor_name gin_trgm_ops);
CREATE INDEX ix_vendor_approved ON mdm.vendor(is_approved, status);

CREATE TABLE mdm.vendor_contact (
    contact_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id  BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id) ON DELETE CASCADE,
    name       VARCHAR(100) NOT NULL,
    email      VARCHAR(120),
    phone      VARCHAR(30),
    is_primary BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_vendor_contact ON mdm.vendor_contact(vendor_id);

CREATE TABLE mdm.vendor_address (
    address_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id  BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id) ON DELETE CASCADE,
    line1      VARCHAR(150) NOT NULL,
    city       VARCHAR(60),
    state      VARCHAR(60),
    state_code VARCHAR(4),
    pincode    VARCHAR(10),
    country    VARCHAR(60) NOT NULL DEFAULT 'India'
);
CREATE INDEX ix_vendor_addr ON mdm.vendor_address(vendor_id);

CREATE TABLE mdm.vendor_rating (
    rating_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id    BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id) ON DELETE CASCADE,
    period       VARCHAR(9) NOT NULL,
    score        NUMERIC(4,2) NOT NULL,
    on_time_pct  NUMERIC(9,4),
    quality_pct  NUMERIC(9,4),
    CONSTRAINT uq_vendor_rating UNIQUE (vendor_id, period)
);

-- ---------- Item / Material master ----------
CREATE TABLE mdm.item (
    item_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT NOT NULL REFERENCES mdm.company(company_id),
    item_code        VARCHAR(30) NOT NULL UNIQUE,
    item_name        VARCHAR(200) NOT NULL,
    item_category_id BIGINT NOT NULL REFERENCES mdm.item_category(category_id),
    item_type        VARCHAR(15) NOT NULL,
    base_uom_id      BIGINT NOT NULL REFERENCES mdm.uom(uom_id),
    hsn_sac_id       BIGINT REFERENCES mdm.hsn_sac(hsn_id),
    is_critical      BOOLEAN NOT NULL DEFAULT false,
    is_serialized    BOOLEAN NOT NULL DEFAULT false,
    is_batch_tracked BOOLEAN NOT NULL DEFAULT false,
    lead_time_days   INT NOT NULL DEFAULT 0,
    std_cost         NUMERIC(20,6) NOT NULL DEFAULT 0,
    reorder_level    NUMERIC(20,4),
    abc_class        CHAR(1) CHECK (abc_class IN ('A','B','C')),
    valuation_method VARCHAR(10) NOT NULL DEFAULT 'WAVG',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_item_type CHECK (item_type IN ('RAW','BOUGHT_OUT','SEMI_FIN','FINISHED','SERVICE','SPARE')),
    CONSTRAINT ck_item_valuation CHECK (valuation_method IN ('FIFO','WAVG','STD'))
);
CREATE INDEX ix_item_category ON mdm.item(item_category_id);
CREATE INDEX ix_item_type ON mdm.item(item_type);
CREATE INDEX ix_item_critical ON mdm.item(is_critical) WHERE is_critical = true;
CREATE INDEX ix_item_name_trgm ON mdm.item USING gin (item_name gin_trgm_ops);

-- ---------- Routing (process master, M08) ----------
CREATE TABLE mdm.routing (
    routing_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id    BIGINT NOT NULL REFERENCES mdm.item(item_id),
    revision   VARCHAR(10) NOT NULL DEFAULT 'A',
    is_active  BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_routing UNIQUE (item_id, revision)
);

CREATE TABLE mdm.routing_operation (
    routing_op_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    routing_id    BIGINT NOT NULL REFERENCES mdm.routing(routing_id) ON DELETE CASCADE,
    op_seq        SMALLINT NOT NULL,
    work_center_id BIGINT NOT NULL REFERENCES mdm.work_center(wc_id),
    op_description VARCHAR(150),
    std_time_min  NUMERIC(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_routing_op UNIQUE (routing_id, op_seq)
);
CREATE INDEX ix_routing_op_wc ON mdm.routing_operation(work_center_id);

-- ---------- BOM (EBOM/MBOM) (FRD gap-fill, load-bearing) ----------
CREATE TABLE mdm.bom_header (
    bom_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bom_no         VARCHAR(30) NOT NULL UNIQUE,
    parent_item_id BIGINT NOT NULL REFERENCES mdm.item(item_id),
    bom_type       VARCHAR(5) NOT NULL,
    revision       VARCHAR(10) NOT NULL,
    project_id     BIGINT,                  -- FK -> proj.project (deferred to 06)
    status         VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    effective_from DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_bom_type CHECK (bom_type IN ('EBOM','MBOM')),
    CONSTRAINT ck_bom_status CHECK (status IN ('DRAFT','RELEASED','OBSOLETE')),
    CONSTRAINT uq_bom UNIQUE (parent_item_id, bom_type, revision)
);
CREATE INDEX ix_bom_project ON mdm.bom_header(project_id);
CREATE INDEX ix_bom_status ON mdm.bom_header(status);

CREATE TABLE mdm.bom_line (
    bom_line_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bom_id            BIGINT NOT NULL REFERENCES mdm.bom_header(bom_id) ON DELETE CASCADE,
    component_item_id BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty_per           NUMERIC(20,6) NOT NULL CHECK (qty_per > 0),
    uom_id            BIGINT NOT NULL REFERENCES mdm.uom(uom_id),
    scrap_pct         NUMERIC(9,4) NOT NULL DEFAULT 0,
    is_critical       BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_bom_line UNIQUE (bom_id, component_item_id)
);
CREATE INDEX ix_bom_line_component ON mdm.bom_line(component_item_id);

-- End Part 1/6
