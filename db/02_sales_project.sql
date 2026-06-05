-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 2/6 : SALES + PROJECT
-- Modules: M01 Enquiry, M02 Quotation, M03 Project, M04 Planning/Gantt,
--          Change Orders, M09 Delivery Prediction
-- =====================================================================

-- =====================================================================
-- SALES (sales)
-- =====================================================================

CREATE TABLE sales.enquiry (
    enquiry_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    enquiry_no     VARCHAR(30) NOT NULL UNIQUE,
    customer_id    BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    enquiry_date   DATE NOT NULL DEFAULT current_date,
    source         VARCHAR(20),
    target_value   NUMERIC(20,4),
    required_date  DATE,
    qualification  VARCHAR(15) NOT NULL DEFAULT 'NEW',
    lost_reason_id BIGINT REFERENCES mdm.reason_code(reason_id),
    assigned_to    BIGINT REFERENCES sec.app_user(user_id),
    status         VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_enq_source CHECK (source IN ('EMAIL','WEB','PHONE','WALKIN','REP')),
    CONSTRAINT ck_enq_qual   CHECK (qualification IN ('NEW','QUALIFIED','LOST')),
    CONSTRAINT ck_enq_status CHECK (status IN ('OPEN','CONVERTED','LOST','CLOSED'))
);
CREATE INDEX ix_enquiry_customer ON sales.enquiry(customer_id);
CREATE INDEX ix_enquiry_status   ON sales.enquiry(status, enquiry_date);
CREATE INDEX ix_enquiry_assigned ON sales.enquiry(assigned_to);

CREATE TABLE sales.enquiry_line (
    enquiry_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    enquiry_id      BIGINT NOT NULL REFERENCES sales.enquiry(enquiry_id) ON DELETE CASCADE,
    item_id         BIGINT REFERENCES mdm.item(item_id),
    description     VARCHAR(300) NOT NULL,
    qty             NUMERIC(20,4),
    uom_id          BIGINT REFERENCES mdm.uom(uom_id)
);
CREATE INDEX ix_enquiry_line ON sales.enquiry_line(enquiry_id);

CREATE TABLE sales.enquiry_attachment (
    attachment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    enquiry_id    BIGINT NOT NULL REFERENCES sales.enquiry(enquiry_id) ON DELETE CASCADE,
    file_ref      VARCHAR(400) NOT NULL,
    doc_type      VARCHAR(40),
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_enq_attach ON sales.enquiry_attachment(enquiry_id);

CREATE TABLE sales.quotation (
    quotation_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       BIGINT NOT NULL REFERENCES mdm.company(company_id),
    quotation_no     VARCHAR(30) NOT NULL UNIQUE,
    enquiry_id       BIGINT REFERENCES sales.enquiry(enquiry_id),
    customer_id      BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    current_revision SMALLINT NOT NULL DEFAULT 0,
    quote_date       DATE NOT NULL DEFAULT current_date,
    valid_until      DATE,
    currency_id      BIGINT NOT NULL REFERENCES mdm.currency(currency_id),
    total_cost       NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_price      NUMERIC(20,4) NOT NULL DEFAULT 0,
    margin_pct       NUMERIC(9,4) GENERATED ALWAYS AS
                       ((total_price - total_cost) / NULLIF(total_price,0) * 100) STORED,
    payment_term_id  BIGINT REFERENCES mdm.payment_term(term_id),
    incoterm_id      BIGINT REFERENCES mdm.incoterm(incoterm_id),
    status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_quote_status CHECK (status IN
        ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','NEGOTIATION','WON','LOST'))
);
CREATE INDEX ix_quotation_customer ON sales.quotation(customer_id);
CREATE INDEX ix_quotation_status   ON sales.quotation(status);
CREATE INDEX ix_quotation_enquiry  ON sales.quotation(enquiry_id);

CREATE TABLE sales.quotation_revision (
    revision_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quotation_id BIGINT NOT NULL REFERENCES sales.quotation(quotation_id) ON DELETE CASCADE,
    rev_no       SMALLINT NOT NULL,
    snapshot     JSONB,
    reason       VARCHAR(300),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   BIGINT REFERENCES sec.app_user(user_id),
    CONSTRAINT uq_quote_rev UNIQUE (quotation_id, rev_no)
);

CREATE TABLE sales.quotation_line (
    line_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quotation_id BIGINT NOT NULL REFERENCES sales.quotation(quotation_id) ON DELETE CASCADE,
    item_id      BIGINT REFERENCES mdm.item(item_id),
    description  VARCHAR(300) NOT NULL,
    qty          NUMERIC(20,4) NOT NULL DEFAULT 1,
    unit_price   NUMERIC(20,6) NOT NULL DEFAULT 0,
    line_amount  NUMERIC(20,4) NOT NULL DEFAULT 0,
    is_optional  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_quote_line ON sales.quotation_line(quotation_id);

CREATE TABLE sales.cost_sheet (
    cost_sheet_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quotation_id  BIGINT NOT NULL REFERENCES sales.quotation(quotation_id) ON DELETE CASCADE,
    rev_no        SMALLINT NOT NULL DEFAULT 0,
    total_cost    NUMERIC(20,4) NOT NULL DEFAULT 0,
    CONSTRAINT uq_cost_sheet UNIQUE (quotation_id, rev_no)
);

CREATE TABLE sales.cost_sheet_line (
    cost_line_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cost_sheet_id BIGINT NOT NULL REFERENCES sales.cost_sheet(cost_sheet_id) ON DELETE CASCADE,
    cost_type     VARCHAR(15) NOT NULL,
    description   VARCHAR(200),
    amount        NUMERIC(20,4) NOT NULL DEFAULT 0,
    CONSTRAINT ck_cost_type CHECK (cost_type IN
        ('MATERIAL','LABOUR','BOUGHTOUT','SUBCON','FREIGHT','OVERHEAD','CONTINGENCY'))
);
CREATE INDEX ix_cost_sheet_line ON sales.cost_sheet_line(cost_sheet_id);

-- =====================================================================
-- PROJECT (proj)
-- =====================================================================

CREATE TABLE proj.project (
    project_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    project_no      VARCHAR(30) NOT NULL UNIQUE,
    project_name    VARCHAR(200) NOT NULL,
    customer_id     BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    quotation_id    BIGINT REFERENCES sales.quotation(quotation_id),
    contract_value  NUMERIC(20,4) NOT NULL DEFAULT 0,
    budget_cost     NUMERIC(20,4) NOT NULL DEFAULT 0,
    pm_user_id      BIGINT NOT NULL REFERENCES sec.app_user(user_id),
    planned_start   DATE,
    planned_end     DATE,
    contractual_end DATE,
    ld_pct_per_week NUMERIC(9,4),
    status          VARCHAR(20) NOT NULL DEFAULT 'PLANNING',
    health_rag      CHAR(1) CHECK (health_rag IN ('R','A','G')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_project_status CHECK (status IN
        ('PLANNING','ACTIVE','ON_HOLD','DELIVERED','CLOSED','CANCELLED'))
);
CREATE INDEX ix_project_customer ON proj.project(customer_id);
CREATE INDEX ix_project_status   ON proj.project(status);
CREATE INDEX ix_project_pm       ON proj.project(pm_user_id);
CREATE INDEX ix_project_due      ON proj.project(contractual_end) WHERE status = 'ACTIVE';

CREATE TABLE proj.wbs_element (
    wbs_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    parent_wbs_id BIGINT REFERENCES proj.wbs_element(wbs_id),
    wbs_code      VARCHAR(40) NOT NULL,
    wbs_name      VARCHAR(200) NOT NULL,
    budget_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    is_billing_milestone BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT uq_wbs UNIQUE (project_id, wbs_code)
);
CREATE INDEX ix_wbs_parent ON proj.wbs_element(parent_wbs_id);

CREATE TABLE proj.milestone (
    milestone_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    wbs_id       BIGINT REFERENCES proj.wbs_element(wbs_id),
    name         VARCHAR(150) NOT NULL,
    planned_date DATE,
    actual_date  DATE,
    is_payment_milestone BOOLEAN NOT NULL DEFAULT false,
    bill_pct     NUMERIC(9,4),
    bill_amount  NUMERIC(20,4),
    status       VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    CONSTRAINT ck_milestone_status CHECK (status IN ('PENDING','ACHIEVED','BILLED','PAID'))
);
CREATE INDEX ix_milestone_project ON proj.milestone(project_id);

CREATE TABLE proj.project_team (
    team_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES sec.app_user(user_id),
    role_on_project VARCHAR(40),
    CONSTRAINT uq_proj_team UNIQUE (project_id, user_id)
);
CREATE INDEX ix_proj_team_user ON proj.project_team(user_id);

CREATE TABLE proj.task (
    task_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id       BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    wbs_id           BIGINT REFERENCES proj.wbs_element(wbs_id),
    task_name        VARCHAR(200) NOT NULL,
    planned_start    DATE NOT NULL,
    planned_end      DATE NOT NULL,
    actual_start     DATE,
    actual_end       DATE,
    baseline_start   DATE,
    baseline_end     DATE,
    percent_complete NUMERIC(9,4) NOT NULL DEFAULT 0,
    is_critical_path BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_task_pct CHECK (percent_complete BETWEEN 0 AND 100),
    CONSTRAINT ck_task_dates CHECK (planned_end >= planned_start)
);
CREATE INDEX ix_task_project ON proj.task(project_id);
CREATE INDEX ix_task_wbs     ON proj.task(wbs_id);
CREATE INDEX ix_task_end     ON proj.task(planned_end);

CREATE TABLE proj.task_dependency (
    dependency_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pred_task_id  BIGINT NOT NULL REFERENCES proj.task(task_id) ON DELETE CASCADE,
    succ_task_id  BIGINT NOT NULL REFERENCES proj.task(task_id) ON DELETE CASCADE,
    dep_type      VARCHAR(2) NOT NULL DEFAULT 'FS',
    lag_days      INT NOT NULL DEFAULT 0,
    CONSTRAINT ck_dep_type CHECK (dep_type IN ('FS','SS','FF','SF')),
    CONSTRAINT ck_dep_self  CHECK (pred_task_id <> succ_task_id),
    CONSTRAINT uq_dep UNIQUE (pred_task_id, succ_task_id)
);
CREATE INDEX ix_dep_succ ON proj.task_dependency(succ_task_id);

CREATE TABLE proj.task_resource (
    task_res_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id       BIGINT NOT NULL REFERENCES proj.task(task_id) ON DELETE CASCADE,
    employee_id   BIGINT NOT NULL,    -- FK -> hcm.employee (deferred to 06)
    planned_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_task_res UNIQUE (task_id, employee_id)
);
CREATE INDEX ix_task_res_emp ON proj.task_resource(employee_id);

CREATE TABLE proj.baseline (
    baseline_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    baseline_no  SMALLINT NOT NULL,
    snapshot     JSONB,
    approved_by  BIGINT REFERENCES sec.app_user(user_id),
    approved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_baseline UNIQUE (project_id, baseline_no)
);

CREATE TABLE proj.change_order (
    change_order_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id           BIGINT NOT NULL REFERENCES mdm.company(company_id),
    co_no                VARCHAR(30) NOT NULL UNIQUE,
    project_id           BIGINT NOT NULL REFERENCES proj.project(project_id),
    description          TEXT NOT NULL,
    cost_impact          NUMERIC(20,4) NOT NULL DEFAULT 0,
    price_impact         NUMERIC(20,4) NOT NULL DEFAULT 0,
    schedule_impact_days INT NOT NULL DEFAULT 0,
    status               VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_co_status CHECK (status IN ('DRAFT','PENDING','CUSTOMER_APPROVED','REJECTED'))
);
CREATE INDEX ix_co_project ON proj.change_order(project_id, status);

CREATE TABLE proj.delivery_forecast (
    forecast_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id         BIGINT NOT NULL REFERENCES proj.project(project_id) ON DELETE CASCADE,
    forecast_date      DATE NOT NULL DEFAULT current_date,
    predicted_delivery DATE NOT NULL,
    committed_delivery DATE,
    delay_days         INT GENERATED ALWAYS AS (predicted_delivery - committed_delivery) STORED,
    risk_level         VARCHAR(10),
    driver             VARCHAR(30),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    CONSTRAINT ck_fc_risk   CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
    CONSTRAINT ck_fc_driver CHECK (driver IN ('MATERIAL','CAPACITY','SCHEDULE','QUALITY'))
);
CREATE INDEX ix_forecast_project ON proj.delivery_forecast(project_id, forecast_date DESC);
CREATE INDEX ix_forecast_risk    ON proj.delivery_forecast(risk_level) WHERE risk_level = 'HIGH';

-- End Part 2/6
