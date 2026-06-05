-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 7 : DOCUMENT NUMBERING ENGINE
-- Auto-generated, gapless, multi-year, multi-branch, audit-compliant.
-- Supersedes the placeholder mdm.numbering_series.
-- Run AFTER 06.
-- =====================================================================

-- Drop the placeholder (was empty; nothing references it)
DROP TABLE IF EXISTS mdm.numbering_series;

-- ---------------------------------------------------------------------
-- 7.1 Series definition (one row per series; branch-specific or company-wide)
-- ---------------------------------------------------------------------
CREATE TABLE mdm.numbering_rule (
    rule_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id     BIGINT NOT NULL REFERENCES mdm.company(company_id),
    bu_id          BIGINT REFERENCES mdm.business_unit(bu_id),  -- NULL = company-wide
    doc_type       VARCHAR(30) NOT NULL,
    prefix         VARCHAR(15) NOT NULL,
    format_template VARCHAR(80) NOT NULL DEFAULT '{PREFIX}/{BRANCH}/{FY}/{SEQ}',
    pad_width      SMALLINT NOT NULL DEFAULT 6,
    separator      CHAR(1) NOT NULL DEFAULT '/',
    reset_policy   VARCHAR(10) NOT NULL DEFAULT 'FY',
    start_no       BIGINT NOT NULL DEFAULT 1,
    is_gapless     BOOLEAN NOT NULL DEFAULT true,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  BIGINT REFERENCES sec.app_user(user_id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES sec.app_user(user_id),
    row_version INT NOT NULL DEFAULT 1,
    CONSTRAINT ck_reset_policy CHECK (reset_policy IN ('FY','CALYEAR','MONTH','NONE'))
);
-- one rule per (company, branch-or-companywide, doc_type)
CREATE UNIQUE INDEX uq_numbering_rule
    ON mdm.numbering_rule (company_id, COALESCE(bu_id, 0), doc_type)
    WHERE is_active;

-- ---------------------------------------------------------------------
-- 7.2 Live counter (the only hot, locked row) -- auto-created per period
-- ---------------------------------------------------------------------
-- period_key holds the reset bucket; for model-scoped serials it also carries
-- the model (e.g. '2026|XR200') so each model restarts its own sequence.
CREATE TABLE mdm.numbering_counter (
    rule_id    BIGINT NOT NULL REFERENCES mdm.numbering_rule(rule_id) ON DELETE CASCADE,
    period_key VARCHAR(40) NOT NULL,
    next_no    BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_id, period_key)
);

-- ---------------------------------------------------------------------
-- 7.3 Append-only issuance ledger (audit) -- guarantees uniqueness too
-- ---------------------------------------------------------------------
CREATE TABLE mdm.numbering_allocation (
    allocation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
    rule_id       BIGINT NOT NULL REFERENCES mdm.numbering_rule(rule_id),
    period_key    VARCHAR(40) NOT NULL,
    seq_no        BIGINT NOT NULL,
    full_number   VARCHAR(60) NOT NULL,
    doc_type      VARCHAR(30) NOT NULL,
    doc_id        BIGINT,                 -- back-reference once the doc row exists
    allocated_by  BIGINT REFERENCES sec.app_user(user_id),
    allocated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_alloc_number UNIQUE (company_id, full_number),
    CONSTRAINT uq_alloc_seq    UNIQUE (rule_id, period_key, seq_no)
);
CREATE INDEX ix_alloc_doc ON mdm.numbering_allocation(doc_type, doc_id);

-- ---------------------------------------------------------------------
-- 7.4 Period-key function (FY uses company fiscal-year-start month)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mdm.compute_period_key(
    p_reset_policy text, p_as_of date, p_fy_start_month smallint)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    y int := extract(year from p_as_of)::int;
    m int := extract(month from p_as_of)::int;
    fy_start int;
BEGIN
    IF p_reset_policy = 'NONE' THEN
        RETURN 'ALL';
    ELSIF p_reset_policy = 'CALYEAR' THEN
        RETURN to_char(p_as_of, 'YYYY');
    ELSIF p_reset_policy = 'MONTH' THEN
        RETURN to_char(p_as_of, 'YYYYMM');
    ELSE  -- FY
        fy_start := COALESCE(p_fy_start_month, 4);
        IF m >= fy_start THEN
            RETURN y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0');
        ELSE
            RETURN (y - 1)::text || '-' || lpad((y % 100)::text, 2, '0');
        END IF;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7.5 Core allocator -- auto, gapless, concurrency-safe
--     Optional p_model fills {MODEL} (machine serials).
--     Set session user first:  SET app.user_id = '<user_id>';
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mdm.next_document_no(
    p_company_id bigint,
    p_bu_id      bigint,
    p_doc_type   text,
    p_model      text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    r           mdm.numbering_rule;
    v_fy_start  smallint;
    v_period    text;        -- displayed period (the {FY} token)
    v_ckey      text;        -- counter scope key (period + model for serials)
    v_branch    text := '';
    v_seq       bigint;
    v_number    text;
    v_user      bigint := NULLIF(current_setting('app.user_id', true), '')::bigint;
BEGIN
    -- prefer a branch-specific rule, else fall back to the company-wide rule
    SELECT * INTO r
    FROM mdm.numbering_rule
    WHERE company_id = p_company_id
      AND doc_type   = p_doc_type
      AND is_active
      AND (bu_id = p_bu_id OR bu_id IS NULL)
    ORDER BY (bu_id IS NULL)        -- false (branch-specific) sorts first
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active numbering rule for doc_type=% company=%', p_doc_type, p_company_id;
    END IF;

    SELECT fiscal_year_start_month INTO v_fy_start FROM mdm.company WHERE company_id = p_company_id;
    v_period := mdm.compute_period_key(r.reset_policy, current_date, v_fy_start);

    -- counter scope: period, plus model for model-scoped serials
    v_ckey := v_period;
    IF coalesce(p_model, '') <> '' THEN
        v_ckey := v_period || '|' || p_model;
    END IF;

    IF p_bu_id IS NOT NULL THEN
        SELECT bu_code INTO v_branch FROM mdm.business_unit WHERE bu_id = p_bu_id;
    END IF;

    -- atomic, gapless increment (single locked counter row)
    INSERT INTO mdm.numbering_counter (rule_id, period_key, next_no)
    VALUES (r.rule_id, v_ckey, r.start_no + 1)
    ON CONFLICT (rule_id, period_key)
    DO UPDATE SET next_no = mdm.numbering_counter.next_no + 1,
                  updated_at = now()
    RETURNING next_no - 1 INTO v_seq;

    v_number := r.format_template;
    v_number := replace(v_number, '{PREFIX}', r.prefix);
    v_number := replace(v_number, '{BRANCH}', v_branch);
    v_number := replace(v_number, '{FY}',     v_period);
    v_number := replace(v_number, '{MODEL}',  coalesce(p_model, ''));
    v_number := replace(v_number, '{SEQ}',    lpad(v_seq::text, r.pad_width, '0'));

    -- immutable audit ledger (also enforces global uniqueness)
    INSERT INTO mdm.numbering_allocation
        (company_id, rule_id, period_key, seq_no, full_number, doc_type, allocated_by)
    VALUES (p_company_id, r.rule_id, v_ckey, v_seq, v_number, p_doc_type, v_user);

    RETURN v_number;
END $$;

-- ---------------------------------------------------------------------
-- 7.6 Gap-detection view (statutory audit)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mdm.v_numbering_gaps AS
WITH bounds AS (
    SELECT rule_id, period_key, min(seq_no) AS lo, max(seq_no) AS hi
    FROM mdm.numbering_allocation
    GROUP BY rule_id, period_key
)
SELECT b.rule_id, ru.doc_type, b.period_key, g AS missing_seq
FROM bounds b
JOIN mdm.numbering_rule ru ON ru.rule_id = b.rule_id
CROSS JOIN LATERAL generate_series(b.lo, b.hi) g
WHERE NOT EXISTS (
    SELECT 1 FROM mdm.numbering_allocation a
    WHERE a.rule_id = b.rule_id AND a.period_key = b.period_key AND a.seq_no = g
);

-- ---------------------------------------------------------------------
-- 7.7 Grants -- allocation ledger is append-only
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON mdm.numbering_rule, mdm.numbering_counter TO erp_app;
GRANT SELECT, INSERT ON mdm.numbering_allocation TO erp_app;
REVOKE UPDATE, DELETE ON mdm.numbering_allocation FROM erp_app;
GRANT SELECT ON mdm.v_numbering_gaps TO erp_app, erp_readonly, erp_reporting;

-- ---------------------------------------------------------------------
-- 7.8 Seed numbering rules for the BE company + 2 sample branches
-- ---------------------------------------------------------------------
INSERT INTO mdm.business_unit (company_id, bu_code, bu_name, bu_type)
SELECT c.company_id, x.code, x.name, 'PLANT'
FROM mdm.company c
CROSS JOIN (VALUES ('MUM','Mumbai Plant'), ('PUN','Pune Plant')) AS x(code, name)
WHERE c.company_code = 'BE'
ON CONFLICT (company_id, bu_code) DO NOTHING;

-- Branch-scoped FY rules for all transactional doc types
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, d.doc_type, d.prefix, '{PREFIX}/{BRANCH}/{FY}/{SEQ}', d.pad, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
CROSS JOIN (VALUES
    ('ENQUIRY','ENQ',6), ('QUOTATION','QTN',6), ('PROJECT','PRJ',5),
    ('PR','PR',6), ('PO','PO',6), ('GRN','GRN',6), ('FAT','FAT',5),
    ('DISPATCH','DSP',6), ('INSTALL','INST',5), ('SERVICE_TICKET','TKT',6)
) AS d(doc_type, prefix, pad)
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- Machine serial: company-wide (bu_id NULL), calendar-year, model-scoped, never branch
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, NULL, 'MACHINE_SERIAL', 'BE', '{PREFIX}-{MODEL}-{FY}-{SEQ}', 5, 'CALYEAR'
FROM mdm.company c WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- End Part 7 -- numbering engine.
