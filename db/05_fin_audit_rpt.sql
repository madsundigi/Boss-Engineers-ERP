-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 5/6 : FINANCE + AUDIT + REPORTING
-- Modules: M15 Profitability (+ Billing/Tax/GL gaps), audit, M16 reporting
-- =====================================================================

-- =====================================================================
-- FINANCE (fin)
-- =====================================================================

CREATE TABLE fin.invoice (              -- AR / customer invoice
    invoice_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    invoice_no     VARCHAR(30) NOT NULL UNIQUE,
    project_id     BIGINT REFERENCES proj.project(project_id),
    customer_id    BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    milestone_id   BIGINT REFERENCES proj.milestone(milestone_id),
    invoice_date   DATE NOT NULL DEFAULT current_date,
    currency_id    BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    taxable_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    tax_amount     NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_amount   NUMERIC(20,4) NOT NULL DEFAULT 0,
    irn            VARCHAR(64),            -- GST e-invoice reference number
    ack_no         VARCHAR(30),
    status         VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_invoice_status CHECK (status IN ('DRAFT','POSTED','SENT','PARTIALLY_PAID','PAID','CANCELLED'))
);
CREATE INDEX ix_invoice_customer ON fin.invoice(customer_id);
CREATE INDEX ix_invoice_project  ON fin.invoice(project_id);
CREATE INDEX ix_invoice_status   ON fin.invoice(status, invoice_date);

-- wire deferred dispatch -> invoice FK now that fin.invoice exists
ALTER TABLE log.dispatch
    ADD CONSTRAINT fk_dispatch_invoice FOREIGN KEY (invoice_id) REFERENCES fin.invoice(invoice_id);

CREATE TABLE fin.invoice_line (
    invoice_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id   BIGINT NOT NULL REFERENCES fin.invoice(invoice_id) ON DELETE CASCADE,
    item_id      BIGINT REFERENCES mdm.item(item_id),
    description  VARCHAR(300) NOT NULL,
    qty          NUMERIC(20,4) NOT NULL DEFAULT 1,
    unit_rate    NUMERIC(20,6) NOT NULL DEFAULT 0,
    taxable_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    tax_code_id  BIGINT REFERENCES mdm.tax_code(tax_code_id),
    tax_amount   NUMERIC(20,4) NOT NULL DEFAULT 0
);
CREATE INDEX ix_invoice_line ON fin.invoice_line(invoice_id);

CREATE TABLE fin.payment_receipt (
    receipt_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    receipt_no   VARCHAR(30) NOT NULL UNIQUE,
    customer_id  BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    receipt_date DATE NOT NULL DEFAULT current_date,
    amount       NUMERIC(20,4) NOT NULL,
    mode         VARCHAR(20),
    reference    VARCHAR(60)
);
CREATE INDEX ix_receipt_customer ON fin.payment_receipt(customer_id);

CREATE TABLE fin.payment_allocation (
    allocation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id    BIGINT NOT NULL REFERENCES fin.payment_receipt(receipt_id) ON DELETE CASCADE,
    invoice_id    BIGINT NOT NULL REFERENCES fin.invoice(invoice_id),
    allocated_amount NUMERIC(20,4) NOT NULL
);
CREATE INDEX ix_alloc_invoice ON fin.payment_allocation(invoice_id);

CREATE TABLE fin.vendor_invoice (       -- AP / vendor bill (3-way match)
    vendor_invoice_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    vinv_no      VARCHAR(40) NOT NULL,
    vendor_id    BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    po_id        BIGINT REFERENCES scm.purchase_order(po_id),
    grn_id       BIGINT REFERENCES scm.goods_receipt(grn_id),
    invoice_date DATE NOT NULL,
    total_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    status       VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    CONSTRAINT uq_vendor_invoice UNIQUE (vendor_id, vinv_no),
    CONSTRAINT ck_vinv_status CHECK (status IN ('PENDING','MATCHED','APPROVED','PAID','DISPUTED'))
);
CREATE INDEX ix_vinv_vendor ON fin.vendor_invoice(vendor_id);
CREATE INDEX ix_vinv_po     ON fin.vendor_invoice(po_id);

CREATE TABLE fin.vendor_invoice_line (
    vinv_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_invoice_id BIGINT NOT NULL REFERENCES fin.vendor_invoice(vendor_invoice_id) ON DELETE CASCADE,
    item_id      BIGINT REFERENCES mdm.item(item_id),
    qty          NUMERIC(20,4),
    unit_rate    NUMERIC(20,6),
    amount       NUMERIC(20,4) NOT NULL DEFAULT 0
);

CREATE TABLE fin.vendor_payment (
    vpay_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES mdm.company(company_id),
    vpay_no    VARCHAR(30) NOT NULL UNIQUE,
    vendor_id  BIGINT NOT NULL REFERENCES mdm.vendor(vendor_id),
    vendor_invoice_id BIGINT REFERENCES fin.vendor_invoice(vendor_invoice_id),
    pay_date   DATE NOT NULL DEFAULT current_date,
    amount     NUMERIC(20,4) NOT NULL
);
CREATE INDEX ix_vpay_vendor ON fin.vendor_payment(vendor_id);

-- General Ledger (double-entry) -- PARTITIONED by posting_date (fiscal period)
CREATE TABLE fin.gl_entry (
    gl_entry_id  BIGINT GENERATED ALWAYS AS IDENTITY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    posting_date DATE NOT NULL,
    journal_no   VARCHAR(30) NOT NULL,
    narration    VARCHAR(300),
    source_doc_type VARCHAR(20),
    source_doc_id   BIGINT,
    created_by   BIGINT REFERENCES sec.app_user(user_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_gl_entry PRIMARY KEY (gl_entry_id, posting_date)
) PARTITION BY RANGE (posting_date);
CREATE TABLE fin.gl_entry_default PARTITION OF fin.gl_entry DEFAULT;
CREATE INDEX ix_gl_entry_date ON fin.gl_entry(posting_date);

CREATE TABLE fin.gl_entry_line (
    gl_line_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gl_entry_id  BIGINT NOT NULL,
    posting_date DATE NOT NULL,
    gl_id        BIGINT NOT NULL REFERENCES mdm.gl_account(gl_id),
    cost_center_id BIGINT REFERENCES mdm.cost_center(cc_id),
    project_id   BIGINT REFERENCES proj.project(project_id),
    debit        NUMERIC(20,4) NOT NULL DEFAULT 0,
    credit       NUMERIC(20,4) NOT NULL DEFAULT 0,
    CONSTRAINT fk_gl_line_entry FOREIGN KEY (gl_entry_id, posting_date)
        REFERENCES fin.gl_entry(gl_entry_id, posting_date) ON DELETE CASCADE,
    CONSTRAINT ck_gl_line_dc CHECK (debit >= 0 AND credit >= 0)
);
CREATE INDEX ix_gl_line_gl      ON fin.gl_entry_line(gl_id);
CREATE INDEX ix_gl_line_project ON fin.gl_entry_line(project_id);

-- *** Project Cost Ledger : heart of M15 Profitability ***
-- Captures BUDGET vs COMMITTED vs ACTUAL by cost type. PARTITIONED by posting_date.
CREATE TABLE fin.project_cost_ledger (
    cost_id      BIGINT GENERATED ALWAYS AS IDENTITY,
    posting_date DATE NOT NULL,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
    wbs_id       BIGINT REFERENCES proj.wbs_element(wbs_id),
    cost_type    VARCHAR(15) NOT NULL,
    cost_stage   VARCHAR(12) NOT NULL,
    amount       NUMERIC(20,4) NOT NULL,
    ref_doc_type VARCHAR(20) NOT NULL,
    ref_doc_id   BIGINT NOT NULL,
    created_by   BIGINT REFERENCES sec.app_user(user_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_proj_cost PRIMARY KEY (cost_id, posting_date),
    CONSTRAINT ck_cost_type2  CHECK (cost_type IN ('MATERIAL','LABOUR','SUBCON','FREIGHT','OVERHEAD','WARRANTY')),
    CONSTRAINT ck_cost_stage  CHECK (cost_stage IN ('BUDGET','COMMITTED','ACTUAL'))
) PARTITION BY RANGE (posting_date);
CREATE TABLE fin.project_cost_ledger_default PARTITION OF fin.project_cost_ledger DEFAULT;
CREATE INDEX ix_pcl_project_stage ON fin.project_cost_ledger(project_id, cost_stage);
CREATE INDEX ix_pcl_project_type  ON fin.project_cost_ledger(project_id, cost_type);
CREATE INDEX ix_pcl_ref           ON fin.project_cost_ledger(ref_doc_type, ref_doc_id);

CREATE TABLE fin.revenue_recognition (
    rev_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
    milestone_id BIGINT REFERENCES proj.milestone(milestone_id),
    recognition_date DATE NOT NULL,
    method       VARCHAR(15) NOT NULL DEFAULT 'MILESTONE',
    amount       NUMERIC(20,4) NOT NULL,
    CONSTRAINT ck_rev_method CHECK (method IN ('MILESTONE','POC','COMPLETED'))
);
CREATE INDEX ix_rev_project ON fin.revenue_recognition(project_id);

CREATE TABLE fin.margin_snapshot (
    snapshot_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT NOT NULL REFERENCES proj.project(project_id),
    snapshot_date DATE NOT NULL DEFAULT current_date,
    revenue       NUMERIC(20,4) NOT NULL DEFAULT 0,
    committed_cost NUMERIC(20,4) NOT NULL DEFAULT 0,
    actual_cost   NUMERIC(20,4) NOT NULL DEFAULT 0,
    forecast_cost_eac NUMERIC(20,4) NOT NULL DEFAULT 0,
    margin_pct    NUMERIC(9,4),
    cpi           NUMERIC(9,4),
    spi           NUMERIC(9,4)
);
CREATE INDEX ix_margin_project ON fin.margin_snapshot(project_id, snapshot_date DESC);

CREATE TABLE fin.tax_transaction (
    tax_txn_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  BIGINT NOT NULL REFERENCES mdm.company(company_id),
    doc_type    VARCHAR(20) NOT NULL,    -- INVOICE, VENDOR_INVOICE
    doc_id      BIGINT NOT NULL,
    txn_date    DATE NOT NULL,
    taxable_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    cgst        NUMERIC(20,4) NOT NULL DEFAULT 0,
    sgst        NUMERIC(20,4) NOT NULL DEFAULT 0,
    igst        NUMERIC(20,4) NOT NULL DEFAULT 0
);
CREATE INDEX ix_tax_doc ON fin.tax_transaction(doc_type, doc_id);
CREATE INDEX ix_tax_date ON fin.tax_transaction(txn_date);

CREATE TABLE fin.advance (
    advance_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id  BIGINT NOT NULL REFERENCES proj.project(project_id),
    customer_id BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    advance_date DATE NOT NULL DEFAULT current_date,
    amount      NUMERIC(20,4) NOT NULL,
    adjusted_amount NUMERIC(20,4) NOT NULL DEFAULT 0
);
CREATE INDEX ix_advance_project ON fin.advance(project_id);

CREATE TABLE fin.retention (
    retention_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
    invoice_id   BIGINT REFERENCES fin.invoice(invoice_id),
    retained_amount NUMERIC(20,4) NOT NULL,
    release_due_date DATE,
    released_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    status       VARCHAR(15) NOT NULL DEFAULT 'HELD',
    CONSTRAINT ck_retention_status CHECK (status IN ('HELD','PARTIAL','RELEASED'))
);
CREATE INDEX ix_retention_project ON fin.retention(project_id);

-- =====================================================================
-- AUDIT (audit)  -- append-only, partitioned
-- =====================================================================

CREATE TABLE audit.audit_log (
    audit_id    BIGINT GENERATED ALWAYS AS IDENTITY,
    event_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
    schema_name VARCHAR(30) NOT NULL,
    table_name  VARCHAR(60) NOT NULL,
    record_pk   BIGINT NOT NULL,
    operation   CHAR(1) NOT NULL,
    changed_by  BIGINT,
    old_values  JSONB,
    new_values  JSONB,
    client_ip   INET,
    CONSTRAINT pk_audit_log PRIMARY KEY (audit_id, event_time),
    CONSTRAINT ck_audit_op CHECK (operation IN ('I','U','D'))
) PARTITION BY RANGE (event_time);
CREATE TABLE audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;
CREATE INDEX ix_audit_table ON audit.audit_log(table_name, record_pk);
CREATE INDEX ix_audit_user  ON audit.audit_log(changed_by, event_time);
CREATE INDEX ix_audit_newval ON audit.audit_log USING gin (new_values);

CREATE TABLE audit.login_audit (
    login_id BIGINT GENERATED ALWAYS AS IDENTITY,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id  BIGINT,
    event    VARCHAR(12) NOT NULL,
    client_ip INET,
    CONSTRAINT pk_login_audit PRIMARY KEY (login_id, ts),
    CONSTRAINT ck_login_event CHECK (event IN ('LOGIN','LOGOUT','FAIL','MFA'))
) PARTITION BY RANGE (ts);
CREATE TABLE audit.login_audit_default PARTITION OF audit.login_audit DEFAULT;
CREATE INDEX ix_login_user ON audit.login_audit(user_id, ts);

CREATE TABLE audit.doc_status_history (
    history_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type    VARCHAR(30) NOT NULL,
    doc_id      BIGINT NOT NULL,
    from_status VARCHAR(20),
    to_status   VARCHAR(20) NOT NULL,
    changed_by  BIGINT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_status_hist_doc ON audit.doc_status_history(doc_type, doc_id);

CREATE TABLE audit.integration_log (
    integ_id  BIGINT GENERATED ALWAYS AS IDENTITY,
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    endpoint  VARCHAR(120) NOT NULL,
    request_payload  JSONB,
    response_payload JSONB,
    status_code INT,
    CONSTRAINT pk_integ_log PRIMARY KEY (integ_id, ts)
) PARTITION BY RANGE (ts);
CREATE TABLE audit.integration_log_default PARTITION OF audit.integration_log DEFAULT;
CREATE INDEX ix_integ_endpoint ON audit.integration_log(endpoint, ts);

-- =====================================================================
-- REPORTING (rpt)  -- star schema (loaded by ETL); M16 dashboard
-- =====================================================================

CREATE TABLE rpt.dim_date (
    date_key  INT PRIMARY KEY,             -- yyyymmdd
    full_date DATE NOT NULL UNIQUE,
    fy        VARCHAR(9) NOT NULL,
    quarter   SMALLINT NOT NULL,
    month     SMALLINT NOT NULL,
    month_name VARCHAR(12) NOT NULL,
    week      SMALLINT NOT NULL,
    day_of_week SMALLINT NOT NULL,
    is_weekend BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE rpt.dim_project (
    project_key  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT NOT NULL,
    project_no   VARCHAR(30) NOT NULL,
    project_name VARCHAR(200),
    customer_name VARCHAR(150),
    pm_name      VARCHAR(120),
    status       VARCHAR(20),
    valid_from   DATE NOT NULL DEFAULT current_date,
    valid_to     DATE,
    is_current   BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX ix_dim_project_src ON rpt.dim_project(project_id) WHERE is_current;

CREATE TABLE rpt.dim_customer (
    customer_key  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id   BIGINT NOT NULL,
    customer_name VARCHAR(150),
    customer_type VARCHAR(20),
    is_current    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rpt.dim_vendor (
    vendor_key  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id   BIGINT NOT NULL,
    vendor_name VARCHAR(150),
    is_current  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rpt.dim_item (
    item_key  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_id   BIGINT NOT NULL,
    item_code VARCHAR(30),
    item_name VARCHAR(200),
    category  VARCHAR(80),
    is_current BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rpt.dim_employee (
    employee_key BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id  BIGINT NOT NULL,
    full_name    VARCHAR(120),
    department   VARCHAR(80),
    is_current   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE rpt.fact_project_financials (
    fact_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key       INT NOT NULL REFERENCES rpt.dim_date(date_key),
    project_key    BIGINT NOT NULL REFERENCES rpt.dim_project(project_key),
    customer_key   BIGINT REFERENCES rpt.dim_customer(customer_key),
    contract_value NUMERIC(20,4),
    budget_cost    NUMERIC(20,4),
    committed_cost NUMERIC(20,4),
    actual_cost    NUMERIC(20,4),
    revenue        NUMERIC(20,4),
    margin_pct     NUMERIC(9,4),
    cpi            NUMERIC(9,4),
    spi            NUMERIC(9,4),
    eac            NUMERIC(20,4)
);
CREATE INDEX ix_fpf_project ON rpt.fact_project_financials(project_key);
CREATE INDEX ix_fpf_date    ON rpt.fact_project_financials(date_key);

CREATE TABLE rpt.fact_sales_funnel (
    fact_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key     INT NOT NULL REFERENCES rpt.dim_date(date_key),
    customer_key BIGINT REFERENCES rpt.dim_customer(customer_key),
    enquiry_value NUMERIC(20,4),
    quoted_value  NUMERIC(20,4),
    won_value     NUMERIC(20,4),
    win_flag      BOOLEAN,
    turnaround_days INT
);

CREATE TABLE rpt.fact_procurement (
    fact_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key    INT NOT NULL REFERENCES rpt.dim_date(date_key),
    vendor_key  BIGINT REFERENCES rpt.dim_vendor(vendor_key),
    item_key    BIGINT REFERENCES rpt.dim_item(item_key),
    project_key BIGINT REFERENCES rpt.dim_project(project_key),
    po_amount   NUMERIC(20,4),
    on_time_flag BOOLEAN,
    savings_vs_estimate NUMERIC(20,4)
);

CREATE TABLE rpt.fact_production (
    fact_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key    INT NOT NULL REFERENCES rpt.dim_date(date_key),
    project_key BIGINT REFERENCES rpt.dim_project(project_key),
    planned_qty NUMERIC(20,4),
    done_qty    NUMERIC(20,4),
    scrap_qty   NUMERIC(20,4),
    schedule_adherence_pct NUMERIC(9,4)
);

CREATE TABLE rpt.fact_inventory (
    fact_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key    INT NOT NULL REFERENCES rpt.dim_date(date_key),
    item_key    BIGINT REFERENCES rpt.dim_item(item_key),
    on_hand_value NUMERIC(20,4),
    reserved_qty  NUMERIC(20,4),
    dead_stock_value NUMERIC(20,4)
);

CREATE TABLE rpt.fact_service (
    fact_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_key     INT NOT NULL REFERENCES rpt.dim_date(date_key),
    customer_key BIGINT REFERENCES rpt.dim_customer(customer_key),
    project_key  BIGINT REFERENCES rpt.dim_project(project_key),
    mttr_hours   NUMERIC(12,2),
    sla_met_flag BOOLEAN,
    warranty_cost NUMERIC(20,4)
);

-- End Part 5/6
