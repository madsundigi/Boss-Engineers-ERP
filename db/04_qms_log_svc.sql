-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 4/6 : QUALITY + LOGISTICS + SERVICE
-- Modules: M10 FAT, M14 Failure Analysis, M11 Dispatch,
--          M12 Installation, M13 Warranty & Service
-- Order: qms -> log -> svc
-- =====================================================================

-- =====================================================================
-- QUALITY (qms)  -- M10 FAT, M14 Failure Analysis
-- =====================================================================

CREATE TABLE qms.fat_protocol (
    protocol_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  BIGINT NOT NULL REFERENCES mdm.company(company_id),
    protocol_code VARCHAR(30) NOT NULL UNIQUE,
    protocol_name VARCHAR(150) NOT NULL,
    item_id     BIGINT REFERENCES mdm.item(item_id),
    test_type   VARCHAR(10) NOT NULL DEFAULT 'FAT',
    is_active   BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT ck_protocol_type CHECK (test_type IN ('FAT','SAT'))
);

CREATE TABLE qms.fat_protocol_param (
    param_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    protocol_id BIGINT NOT NULL REFERENCES qms.fat_protocol(protocol_id) ON DELETE CASCADE,
    seq         SMALLINT NOT NULL,
    param_name  VARCHAR(150) NOT NULL,
    spec_min    NUMERIC(20,6),
    spec_max    NUMERIC(20,6),
    uom         VARCHAR(20),
    CONSTRAINT uq_protocol_param UNIQUE (protocol_id, seq)
);

CREATE TABLE qms.fat_execution (
    fat_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    fat_no          VARCHAR(30) NOT NULL UNIQUE,
    project_id      BIGINT NOT NULL REFERENCES proj.project(project_id),
    wo_id           BIGINT REFERENCES mfg.work_order(wo_id),
    protocol_id     BIGINT NOT NULL REFERENCES qms.fat_protocol(protocol_id),
    fat_date        DATE NOT NULL DEFAULT current_date,
    result          VARCHAR(12),
    customer_witness VARCHAR(120),
    signoff_by      BIGINT REFERENCES sec.app_user(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_fat_result CHECK (result IN ('PASS','FAIL','CONDITIONAL'))
);
CREATE INDEX ix_fat_project ON qms.fat_execution(project_id);
CREATE INDEX ix_fat_result  ON qms.fat_execution(result);

CREATE TABLE qms.fat_result_line (
    result_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fat_id         BIGINT NOT NULL REFERENCES qms.fat_execution(fat_id) ON DELETE CASCADE,
    param_id       BIGINT NOT NULL REFERENCES qms.fat_protocol_param(param_id),
    measured_value NUMERIC(20,6),
    pass_fail      VARCHAR(4) NOT NULL DEFAULT 'PASS',
    CONSTRAINT ck_result_pf CHECK (pass_fail IN ('PASS','FAIL'))
);
CREATE INDEX ix_fat_result_line ON qms.fat_result_line(fat_id);

CREATE TABLE qms.failure_mode (
    failure_mode_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fm_code  VARCHAR(30) NOT NULL UNIQUE,
    fm_name  VARCHAR(150) NOT NULL,
    category VARCHAR(40)
);

CREATE TABLE qms.punch_item (
    punch_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fat_id      BIGINT REFERENCES qms.fat_execution(fat_id),
    install_id  BIGINT,                  -- FK -> svc.installation (deferred to 06)
    description VARCHAR(400) NOT NULL,
    severity    VARCHAR(10),
    status      VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    closed_date DATE,
    CONSTRAINT ck_punch_status CHECK (status IN ('OPEN','CLOSED'))
);
CREATE INDEX ix_punch_fat     ON qms.punch_item(fat_id);
CREATE INDEX ix_punch_install ON qms.punch_item(install_id);

CREATE TABLE qms.inspection (
    inspection_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    insp_no       VARCHAR(30) NOT NULL UNIQUE,
    insp_type     VARCHAR(15) NOT NULL DEFAULT 'INCOMING',
    grn_id        BIGINT REFERENCES scm.goods_receipt(grn_id),
    wo_id         BIGINT REFERENCES mfg.work_order(wo_id),
    insp_date     DATE NOT NULL DEFAULT current_date,
    result        VARCHAR(12),
    CONSTRAINT ck_insp_type CHECK (insp_type IN ('INCOMING','IN_PROCESS','FINAL')),
    CONSTRAINT ck_insp_result CHECK (result IN ('PASS','FAIL','PARTIAL'))
);
CREATE INDEX ix_insp_grn ON qms.inspection(grn_id);

CREATE TABLE qms.inspection_line (
    insp_line_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inspection_id BIGINT NOT NULL REFERENCES qms.inspection(inspection_id) ON DELETE CASCADE,
    item_id       BIGINT NOT NULL REFERENCES mdm.item(item_id),
    sample_qty    NUMERIC(20,4),
    accepted_qty  NUMERIC(20,4),
    rejected_qty  NUMERIC(20,4)
);

CREATE TABLE qms.ncr (
    ncr_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    ncr_no          VARCHAR(30) NOT NULL UNIQUE,
    source          VARCHAR(15) NOT NULL,
    source_doc_id   BIGINT,
    item_id         BIGINT REFERENCES mdm.item(item_id),
    project_id      BIGINT REFERENCES proj.project(project_id),
    failure_mode_id BIGINT REFERENCES qms.failure_mode(failure_mode_id),
    severity        VARCHAR(10),
    raised_date     DATE NOT NULL DEFAULT current_date,
    status          VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_ncr_source CHECK (source IN ('GRN','PRODUCTION','FAT','INSTALL','WARRANTY')),
    CONSTRAINT ck_ncr_status CHECK (status IN ('OPEN','RCA','CAPA','CLOSED'))
);
CREATE INDEX ix_ncr_source  ON qms.ncr(source);
CREATE INDEX ix_ncr_project ON qms.ncr(project_id);
CREATE INDEX ix_ncr_fmode   ON qms.ncr(failure_mode_id);

CREATE TABLE qms.rca (
    rca_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ncr_id      BIGINT NOT NULL REFERENCES qms.ncr(ncr_id) ON DELETE CASCADE,
    method      VARCHAR(10) NOT NULL,
    root_cause  TEXT,
    analysis    JSONB,
    analysed_by BIGINT REFERENCES sec.app_user(user_id),
    analysed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_rca_method CHECK (method IN ('5WHY','FISHBONE','8D'))
);
CREATE INDEX ix_rca_ncr ON qms.rca(ncr_id);

CREATE TABLE qms.capa (
    capa_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ncr_id    BIGINT NOT NULL REFERENCES qms.ncr(ncr_id) ON DELETE CASCADE,
    capa_type VARCHAR(12) NOT NULL,
    action    TEXT NOT NULL,
    owner_id  BIGINT REFERENCES sec.app_user(user_id),
    due_date  DATE,
    effectiveness_check VARCHAR(300),
    status    VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    CONSTRAINT ck_capa_type CHECK (capa_type IN ('CORRECTIVE','PREVENTIVE')),
    CONSTRAINT ck_capa_status CHECK (status IN ('OPEN','IN_PROGRESS','VERIFIED','CLOSED'))
);
CREATE INDEX ix_capa_status ON qms.capa(status, due_date);

CREATE TABLE qms.capa_action (
    capa_action_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    capa_id     BIGINT NOT NULL REFERENCES qms.capa(capa_id) ON DELETE CASCADE,
    description VARCHAR(400) NOT NULL,
    owner_id    BIGINT REFERENCES sec.app_user(user_id),
    due_date    DATE,
    done_date   DATE,
    status      VARCHAR(15) NOT NULL DEFAULT 'OPEN'
);
CREATE INDEX ix_capa_action ON qms.capa_action(capa_id);

-- =====================================================================
-- LOGISTICS (log)  -- M11 Dispatch
-- =====================================================================

CREATE TABLE log.dispatch (
    dispatch_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    dispatch_no  VARCHAR(30) NOT NULL UNIQUE,
    project_id   BIGINT NOT NULL REFERENCES proj.project(project_id),
    customer_id  BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    fat_id       BIGINT REFERENCES qms.fat_execution(fat_id),   -- gate check
    dispatch_date DATE NOT NULL DEFAULT current_date,
    invoice_id   BIGINT,                  -- FK -> fin.invoice (deferred to 06)
    eway_bill_no VARCHAR(20),
    transporter  VARCHAR(120),
    lr_no        VARCHAR(40),
    ship_to_address_id BIGINT REFERENCES mdm.customer_address(address_id),
    status       VARCHAR(15) NOT NULL DEFAULT 'READY',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_dispatch_status CHECK (status IN ('READY','GATE_PASS','DISPATCHED','DELIVERED'))
);
CREATE INDEX ix_dispatch_project  ON log.dispatch(project_id);
CREATE INDEX ix_dispatch_customer ON log.dispatch(customer_id);
CREATE INDEX ix_dispatch_date     ON log.dispatch(dispatch_date);

CREATE TABLE log.dispatch_line (
    dispatch_line_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispatch_id BIGINT NOT NULL REFERENCES log.dispatch(dispatch_id) ON DELETE CASCADE,
    item_id     BIGINT NOT NULL REFERENCES mdm.item(item_id),
    serial_id   BIGINT REFERENCES scm.serial_number(serial_id),
    qty         NUMERIC(20,4) NOT NULL
);
CREATE INDEX ix_dispatch_line ON log.dispatch_line(dispatch_id);

CREATE TABLE log.packing_list (
    packing_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispatch_id BIGINT NOT NULL REFERENCES log.dispatch(dispatch_id) ON DELETE CASCADE,
    package_no  VARCHAR(30) NOT NULL,
    gross_weight NUMERIC(12,3),
    dimensions  VARCHAR(60)
);

CREATE TABLE log.packing_item (
    packing_item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    packing_id  BIGINT NOT NULL REFERENCES log.packing_list(packing_id) ON DELETE CASCADE,
    item_id     BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty         NUMERIC(20,4) NOT NULL
);

-- =====================================================================
-- SERVICE (svc)  -- M12 Installation, M13 Warranty & Service
-- =====================================================================

CREATE TABLE svc.installation (
    install_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
    install_no      VARCHAR(30) NOT NULL UNIQUE,
    project_id      BIGINT NOT NULL REFERENCES proj.project(project_id),
    dispatch_id     BIGINT REFERENCES log.dispatch(dispatch_id),
    site_address    VARCHAR(400),
    planned_date    DATE,
    actual_date     DATE,
    sat_result      VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    acceptance_cert_no VARCHAR(40),
    accepted_date   DATE,
    status          VARCHAR(15) NOT NULL DEFAULT 'PLANNED',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_sat_result CHECK (sat_result IN ('PASS','FAIL','PENDING')),
    CONSTRAINT ck_install_status CHECK (status IN ('PLANNED','IN_PROGRESS','COMMISSIONED','ACCEPTED','CLOSED'))
);
CREATE INDEX ix_install_project ON svc.installation(project_id);

-- wire deferred punch_item -> installation FK
ALTER TABLE qms.punch_item
    ADD CONSTRAINT fk_punch_install FOREIGN KEY (install_id) REFERENCES svc.installation(install_id);

CREATE TABLE svc.warranty (
    warranty_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  BIGINT NOT NULL REFERENCES mdm.company(company_id),
    serial_id   BIGINT NOT NULL REFERENCES scm.serial_number(serial_id),
    project_id  BIGINT NOT NULL REFERENCES proj.project(project_id),
    customer_id BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    terms       TEXT,
    status      VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT uq_warranty_serial UNIQUE (serial_id),
    CONSTRAINT ck_warranty_dates  CHECK (end_date > start_date),
    CONSTRAINT ck_warranty_status CHECK (status IN ('ACTIVE','EXPIRED','VOID'))
);
CREATE INDEX ix_warranty_project ON svc.warranty(project_id);
CREATE INDEX ix_warranty_end     ON svc.warranty(end_date);
CREATE INDEX ix_warranty_customer ON svc.warranty(customer_id);

CREATE TABLE svc.service_contract (
    contract_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id  BIGINT NOT NULL REFERENCES mdm.company(company_id),
    contract_no VARCHAR(30) NOT NULL UNIQUE,
    customer_id BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    project_id  BIGINT REFERENCES proj.project(project_id),
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    contract_value NUMERIC(20,4) NOT NULL DEFAULT 0,
    pm_frequency_days INT,
    status      VARCHAR(15) NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT ck_contract_status CHECK (status IN ('ACTIVE','EXPIRED','RENEWED','CANCELLED'))
);
CREATE INDEX ix_contract_customer ON svc.service_contract(customer_id);

CREATE TABLE svc.sla (
    sla_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id BIGINT NOT NULL REFERENCES svc.service_contract(contract_id) ON DELETE CASCADE,
    priority    VARCHAR(10) NOT NULL,
    response_hours INT NOT NULL,
    resolution_hours INT NOT NULL,
    CONSTRAINT ck_sla_priority CHECK (priority IN ('LOW','MED','HIGH','CRITICAL'))
);

CREATE TABLE svc.service_ticket (
    ticket_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    ticket_no    VARCHAR(30) NOT NULL UNIQUE,
    customer_id  BIGINT NOT NULL REFERENCES mdm.customer(customer_id),
    serial_id    BIGINT REFERENCES scm.serial_number(serial_id),
    warranty_id  BIGINT REFERENCES svc.warranty(warranty_id),
    contract_id  BIGINT REFERENCES svc.service_contract(contract_id),
    priority     VARCHAR(10) NOT NULL DEFAULT 'MED',
    is_in_warranty BOOLEAN NOT NULL DEFAULT false,
    reported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sla_due_at   TIMESTAMPTZ,
    resolution   TEXT,
    status       VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_ticket_priority CHECK (priority IN ('LOW','MED','HIGH','CRITICAL')),
    CONSTRAINT ck_ticket_status CHECK (status IN ('OPEN','ASSIGNED','ON_SITE','RESOLVED','CLOSED'))
);
CREATE INDEX ix_ticket_customer ON svc.service_ticket(customer_id);
CREATE INDEX ix_ticket_status   ON svc.service_ticket(status, priority);
CREATE INDEX ix_ticket_sla      ON svc.service_ticket(sla_due_at) WHERE status NOT IN ('RESOLVED','CLOSED');
CREATE INDEX ix_ticket_serial   ON svc.service_ticket(serial_id);

CREATE TABLE svc.field_visit (
    visit_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id   BIGINT NOT NULL REFERENCES svc.service_ticket(ticket_id) ON DELETE CASCADE,
    engineer_id BIGINT REFERENCES hcm.employee(employee_id),
    visit_date  DATE NOT NULL DEFAULT current_date,
    hours       NUMERIC(6,2),
    travel_cost NUMERIC(20,4) NOT NULL DEFAULT 0,
    notes       TEXT
);
CREATE INDEX ix_visit_ticket ON svc.field_visit(ticket_id);

CREATE TABLE svc.spare_issue (
    spare_issue_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id  BIGINT NOT NULL REFERENCES svc.service_ticket(ticket_id) ON DELETE CASCADE,
    item_id    BIGINT NOT NULL REFERENCES mdm.item(item_id),
    qty        NUMERIC(20,4) NOT NULL,
    unit_cost  NUMERIC(20,6) NOT NULL DEFAULT 0,
    is_chargeable BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ix_spare_ticket ON svc.spare_issue(ticket_id);

CREATE TABLE svc.warranty_claim (
    claim_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    warranty_id BIGINT NOT NULL REFERENCES svc.warranty(warranty_id),
    ticket_id   BIGINT REFERENCES svc.service_ticket(ticket_id),
    claim_date  DATE NOT NULL DEFAULT current_date,
    claim_cost  NUMERIC(20,4) NOT NULL DEFAULT 0,
    status      VARCHAR(15) NOT NULL DEFAULT 'PENDING',
    approved_by BIGINT REFERENCES sec.app_user(user_id),
    CONSTRAINT ck_claim_status CHECK (status IN ('PENDING','APPROVED','REJECTED'))
);
CREATE INDEX ix_claim_warranty ON svc.warranty_claim(warranty_id);

-- End Part 4/6
