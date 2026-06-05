-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 6/6 : DEFERRED FKs, PARTITION
--   AUTOMATION, AUDIT/STATUS TRIGGERS, SEED DATA, ROLES, DASHBOARD MVs
-- Run LAST.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 6.1 Deferred cross-schema foreign keys (forward references)
-- ---------------------------------------------------------------------
ALTER TABLE sec.app_user
    ADD CONSTRAINT fk_app_user_employee
    FOREIGN KEY (employee_id) REFERENCES hcm.employee(employee_id);

ALTER TABLE proj.task_resource
    ADD CONSTRAINT fk_task_resource_employee
    FOREIGN KEY (employee_id) REFERENCES hcm.employee(employee_id);

ALTER TABLE mdm.bom_header
    ADD CONSTRAINT fk_bom_project
    FOREIGN KEY (project_id) REFERENCES proj.project(project_id);

-- ---------------------------------------------------------------------
-- 6.2 Partition automation (declarative; pg_partman recommended in prod)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_month_partition(
    p_schema text, p_table text, p_from date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_to     date := (p_from + interval '1 month')::date;
    v_parent text := format('%I.%I', p_schema, p_table);
    v_part   text := format('%I.%I', p_schema, p_table || '_p' || to_char(p_from,'YYYYMM'));
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        v_part, v_parent, p_from, v_to);
END $$;

-- Pre-create current + next 2 months for every partitioned table.
DO $$
DECLARE
    t RECORD;
    m INT;
    v_start date := date_trunc('month', current_date)::date;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('scm','stock_transaction'),
        ('fin','gl_entry'),
        ('fin','project_cost_ledger'),
        ('audit','audit_log'),
        ('audit','login_audit'),
        ('audit','integration_log')
    ) AS x(sch, tbl) LOOP
        FOR m IN 0..2 LOOP
            PERFORM public.ensure_month_partition(
                t.sch, t.tbl, (v_start + (m || ' month')::interval)::date);
        END LOOP;
    END LOOP;
END $$;
-- Production: schedule monthly job ->
--   SELECT public.ensure_month_partition(...) for next month; detach+archive expired.

-- ---------------------------------------------------------------------
-- 6.3 Generic audit trigger (field-level, append-only) + status history
--     Set per-session user via:  SET app.user_id = '<user_id>';
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.fn_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_pk   bigint;
    v_user bigint := NULLIF(current_setting('app.user_id', true), '')::bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_pk := (to_jsonb(OLD) ->> TG_ARGV[0])::bigint;
        INSERT INTO audit.audit_log(schema_name, table_name, record_pk, operation, changed_by, old_values)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, v_pk, 'D', v_user, to_jsonb(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        v_pk := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;
        INSERT INTO audit.audit_log(schema_name, table_name, record_pk, operation, changed_by, old_values, new_values)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, v_pk, 'U', v_user, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        v_pk := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;
        INSERT INTO audit.audit_log(schema_name, table_name, record_pk, operation, changed_by, new_values)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, v_pk, 'I', v_user, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION audit.fn_status_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_user bigint := NULLIF(current_setting('app.user_id', true), '')::bigint;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO audit.doc_status_history(doc_type, doc_id, from_status, to_status, changed_by)
        VALUES (TG_ARGV[0], (to_jsonb(NEW) ->> TG_ARGV[1])::bigint, OLD.status, NEW.status, v_user);
    END IF;
    RETURN NEW;
END $$;

-- Attach audit to high-value transactional tables (extend to all as needed)
CREATE TRIGGER trg_audit_quotation AFTER INSERT OR UPDATE OR DELETE ON sales.quotation
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('quotation_id');
CREATE TRIGGER trg_audit_project AFTER INSERT OR UPDATE OR DELETE ON proj.project
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('project_id');
CREATE TRIGGER trg_audit_change_order AFTER INSERT OR UPDATE OR DELETE ON proj.change_order
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('change_order_id');
CREATE TRIGGER trg_audit_po AFTER INSERT OR UPDATE OR DELETE ON scm.purchase_order
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('po_id');
CREATE TRIGGER trg_audit_wo AFTER INSERT OR UPDATE OR DELETE ON mfg.work_order
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('wo_id');
CREATE TRIGGER trg_audit_fat AFTER INSERT OR UPDATE OR DELETE ON qms.fat_execution
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('fat_id');
CREATE TRIGGER trg_audit_dispatch AFTER INSERT OR UPDATE OR DELETE ON log.dispatch
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('dispatch_id');
CREATE TRIGGER trg_audit_invoice AFTER INSERT OR UPDATE OR DELETE ON fin.invoice
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('invoice_id');
CREATE TRIGGER trg_audit_customer AFTER INSERT OR UPDATE OR DELETE ON mdm.customer
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('customer_id');
CREATE TRIGGER trg_audit_vendor AFTER INSERT OR UPDATE OR DELETE ON mdm.vendor
    FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('vendor_id');

-- Attach status-history to key lifecycle docs
CREATE TRIGGER trg_status_project AFTER UPDATE ON proj.project
    FOR EACH ROW EXECUTE FUNCTION audit.fn_status_history('PROJECT','project_id');
CREATE TRIGGER trg_status_quotation AFTER UPDATE ON sales.quotation
    FOR EACH ROW EXECUTE FUNCTION audit.fn_status_history('QUOTE','quotation_id');
CREATE TRIGGER trg_status_po AFTER UPDATE ON scm.purchase_order
    FOR EACH ROW EXECUTE FUNCTION audit.fn_status_history('PO','po_id');
CREATE TRIGGER trg_status_ticket AFTER UPDATE ON svc.service_ticket
    FOR EACH ROW EXECUTE FUNCTION audit.fn_status_history('SERVICE_TICKET','ticket_id');

-- ---------------------------------------------------------------------
-- 6.4 Seed reference data (minimal bootstrap)
-- ---------------------------------------------------------------------
INSERT INTO mdm.currency (iso_code, name, symbol)
VALUES ('INR','Indian Rupee','Rs') ON CONFLICT (iso_code) DO NOTHING;

INSERT INTO mdm.company (company_code, legal_name, base_currency_id, fiscal_year_start_month)
SELECT 'BE','Boss Engineers Pvt Ltd', c.currency_id, 4
FROM mdm.currency c WHERE c.iso_code='INR'
ON CONFLICT (company_code) DO NOTHING;

INSERT INTO sec.app_user (username, email, full_name, password_hash, is_active)
VALUES ('admin','admin@bossengineers.local','System Administrator','<set-by-app>',true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO sec.role (role_code, role_name, description)
VALUES ('ADMIN','Administrator','Full access'),
       ('PM','Project Manager','Project owner'),
       ('PURCHASE','Purchase Officer','Procurement'),
       ('QA','Quality','FAT/CAPA'),
       ('FINANCE','Finance','Billing/AR/AP')
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO mdm.uom (uom_code, uom_name) VALUES
   ('NOS','Numbers'),('KG','Kilogram'),('MTR','Meter'),('SET','Set'),('LOT','Lot')
ON CONFLICT (uom_code) DO NOTHING;

INSERT INTO mdm.item_category (cat_code, cat_name) VALUES
   ('RAW','Raw Material'),('BO','Bought Out'),('FG','Finished Goods'),('SPR','Spares')
ON CONFLICT (cat_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6.5 Database roles & privileges (least privilege + audit append-only)
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_app')       THEN CREATE ROLE erp_app NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_reporting') THEN CREATE ROLE erp_reporting NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='erp_readonly')  THEN CREATE ROLE erp_readonly NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA sec, mdm, sales, proj, scm, hcm, mfg, qms, log, svc, fin, rpt TO erp_app;
GRANT USAGE ON SCHEMA audit TO erp_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA
    sec, mdm, sales, proj, scm, hcm, mfg, qms, log, svc, fin, rpt TO erp_app;

-- Audit schema is APPEND-ONLY for the application
GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA audit TO erp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA audit FROM erp_app;

-- Reporting & read-only roles
GRANT USAGE ON SCHEMA rpt TO erp_reporting, erp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA rpt TO erp_reporting, erp_readonly;
GRANT USAGE ON SCHEMA sec, mdm, sales, proj, scm, hcm, mfg, qms, log, svc, fin TO erp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA
    sec, mdm, sales, proj, scm, hcm, mfg, qms, log, svc, fin TO erp_readonly;

-- Default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA mdm, sales, proj, scm, hcm, mfg, qms, log, svc, fin, rpt
    GRANT SELECT, INSERT, UPDATE ON TABLES TO erp_app;

-- ---------------------------------------------------------------------
-- 6.6 CEO Dashboard materialized views (M16) -- refresh CONCURRENTLY
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW rpt.mv_at_risk_projects AS
SELECT p.project_id,
       p.project_no,
       p.project_name,
       p.status,
       p.contractual_end,
       ms.margin_pct,
       df.predicted_delivery,
       df.committed_delivery,
       df.delay_days,
       df.risk_level
FROM proj.project p
LEFT JOIN LATERAL (
    SELECT margin_pct FROM fin.margin_snapshot m
    WHERE m.project_id = p.project_id ORDER BY snapshot_date DESC LIMIT 1) ms ON true
LEFT JOIN LATERAL (
    SELECT predicted_delivery, committed_delivery, delay_days, risk_level
    FROM proj.delivery_forecast d
    WHERE d.project_id = p.project_id ORDER BY forecast_date DESC LIMIT 1) df ON true
WHERE p.status = 'ACTIVE';
CREATE UNIQUE INDEX uq_mv_at_risk ON rpt.mv_at_risk_projects(project_id);

CREATE MATERIALIZED VIEW rpt.mv_project_health_heatmap AS
SELECT p.project_id,
       p.project_no,
       p.project_name,
       p.status,
       p.health_rag,
       p.contract_value,
       p.budget_cost,
       ms.actual_cost,
       ms.margin_pct,
       ms.cpi,
       ms.spi
FROM proj.project p
LEFT JOIN LATERAL (
    SELECT actual_cost, margin_pct, cpi, spi FROM fin.margin_snapshot m
    WHERE m.project_id = p.project_id ORDER BY snapshot_date DESC LIMIT 1) ms ON true
WHERE p.status IN ('ACTIVE','ON_HOLD');
CREATE UNIQUE INDEX uq_mv_heatmap ON rpt.mv_project_health_heatmap(project_id);

CREATE MATERIALIZED VIEW rpt.mv_ceo_portfolio AS
SELECT
    count(*) FILTER (WHERE status = 'ACTIVE')                       AS active_projects,
    coalesce(sum(contract_value) FILTER (WHERE status='ACTIVE'),0)  AS active_order_book,
    coalesce(sum(contract_value) FILTER (WHERE status='DELIVERED'),0) AS delivered_value,
    count(*) FILTER (WHERE health_rag = 'R')                        AS red_projects,
    count(*) FILTER (WHERE health_rag = 'A')                        AS amber_projects,
    count(*) FILTER (WHERE health_rag = 'G')                        AS green_projects
FROM proj.project
WHERE is_deleted = false;
-- single-row MV; no unique index required for non-concurrent refresh

-- Refresh pattern (schedule every 5-15 min):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY rpt.mv_at_risk_projects;
--   REFRESH MATERIALIZED VIEW CONCURRENTLY rpt.mv_project_health_heatmap;
--   REFRESH MATERIALIZED VIEW rpt.mv_ceo_portfolio;

-- End Part 6/6 -- schema complete.
