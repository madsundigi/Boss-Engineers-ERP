-- =====================================================================
-- Boss Engineers ERP  |  Schema Part 9 : ENTERPRISE AUDIT SYSTEM
-- Unified, append-only, tamper-evident event stream for all 8 event types:
--   CREATE, EDIT, DELETE, APPROVE, REJECT, LOGIN, LOGOUT, EXPORT.
-- Captures: user, ip, timestamp, old_value, new_value (+ forensic context).
-- Supersedes audit.audit_log / audit.login_audit (consolidated here).
-- Run AFTER 08.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 9.1 Unified event stream (partitioned monthly, append-only)
-- ---------------------------------------------------------------------
CREATE TABLE audit.audit_event (
    event_id       BIGINT GENERATED ALWAYS AS IDENTITY,
    event_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type     VARCHAR(10) NOT NULL,
    app_user_id    BIGINT,                    -- User
    username       VARCHAR(60),               -- denormalized snapshot
    client_ip      INET,                      -- IP
    user_agent     VARCHAR(300),
    session_id     VARCHAR(80),
    company_id     BIGINT,
    module         VARCHAR(40),
    entity         VARCHAR(80),               -- schema.table or logical entity
    entity_pk      BIGINT,
    old_value      JSONB,                     -- Old Value
    new_value      JSONB,                     -- New Value
    result         VARCHAR(10) NOT NULL DEFAULT 'SUCCESS',
    reason         VARCHAR(500),              -- reject reason / export purpose
    correlation_id UUID,
    row_hash       BYTEA,                     -- tamper-evidence (set on insert)
    CONSTRAINT pk_audit_event PRIMARY KEY (event_id, event_time),
    CONSTRAINT ck_audit_event_type CHECK (event_type IN
        ('CREATE','EDIT','DELETE','APPROVE','REJECT','LOGIN','LOGOUT','EXPORT')),
    CONSTRAINT ck_audit_result CHECK (result IN ('SUCCESS','FAILURE','DENIED'))
) PARTITION BY RANGE (event_time);
CREATE TABLE audit.audit_event_default PARTITION OF audit.audit_event DEFAULT;

CREATE INDEX ix_ae_user   ON audit.audit_event(app_user_id, event_time);
CREATE INDEX ix_ae_entity ON audit.audit_event(entity, entity_pk);
CREATE INDEX ix_ae_type   ON audit.audit_event(event_type, event_time);
CREATE INDEX ix_ae_corr   ON audit.audit_event(correlation_id);
CREATE INDEX ix_ae_newval ON audit.audit_event USING gin (new_value);
CREATE INDEX ix_ae_brin   ON audit.audit_event USING brin (event_time);

-- current + next 2 monthly partitions (extend via the rolling job)
DO $$
DECLARE m int; v_start date := date_trunc('month', current_date)::date;
BEGIN
    FOR m IN 0..2 LOOP
        PERFORM public.ensure_month_partition('audit','audit_event',
            (v_start + (m || ' month')::interval)::date);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 9.2 Content hash (tamper-evidence) -- deterministic, excludes row_hash
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.event_hash(p audit.audit_event)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
    SELECT digest(convert_to(
        coalesce(p.event_id::text,'')      || '|' ||
        coalesce(p.event_type,'')          || '|' ||
        coalesce(to_char(p.event_time,'YYYYMMDD"T"HH24MISS.US'),'') || '|' ||
        coalesce(p.app_user_id::text,'')   || '|' ||
        coalesce(p.username,'')            || '|' ||
        coalesce(host(p.client_ip),'')     || '|' ||
        coalesce(p.module,'')              || '|' ||
        coalesce(p.entity,'')              || '|' ||
        coalesce(p.entity_pk::text,'')     || '|' ||
        coalesce(p.old_value::text,'')     || '|' ||
        coalesce(p.new_value::text,'')     || '|' ||
        coalesce(p.result,'')              || '|' ||
        coalesce(p.reason,''), 'UTF8'), 'sha256');
$$;

CREATE OR REPLACE FUNCTION audit.fn_event_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.row_hash := audit.event_hash(NEW);
    RETURN NEW;
END $$;
CREATE TRIGGER trg_event_hash BEFORE INSERT ON audit.audit_event
    FOR EACH ROW EXECUTE FUNCTION audit.fn_event_hash();

-- ---------------------------------------------------------------------
-- 9.3 Application emit API (APPROVE/REJECT/LOGIN/LOGOUT/EXPORT, etc.)
--     Reads session context from GUCs set by the app per request.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.log_event(
    p_event_type text,
    p_module     text   DEFAULT NULL,
    p_entity     text   DEFAULT NULL,
    p_entity_pk  bigint DEFAULT NULL,
    p_old        jsonb  DEFAULT NULL,
    p_new        jsonb  DEFAULT NULL,
    p_result     text   DEFAULT 'SUCCESS',
    p_reason     text   DEFAULT NULL,
    p_user_id    bigint DEFAULT NULL,
    p_username   text   DEFAULT NULL,
    p_client_ip  inet   DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
    INSERT INTO audit.audit_event(
        event_type, app_user_id, username, client_ip, user_agent, session_id,
        company_id, module, entity, entity_pk, old_value, new_value, result, reason, correlation_id)
    VALUES (
        p_event_type,
        coalesce(p_user_id,  NULLIF(current_setting('app.user_id',   true),'')::bigint),
        coalesce(p_username, NULLIF(current_setting('app.username',  true),'')),
        coalesce(p_client_ip,NULLIF(current_setting('app.client_ip', true),'')::inet),
        NULLIF(current_setting('app.user_agent', true),''),
        NULLIF(current_setting('app.session_id', true),''),
        NULLIF(current_setting('app.company_id', true),'')::bigint,
        p_module, p_entity, p_entity_pk, p_old, p_new, p_result, p_reason,
        NULLIF(current_setting('app.correlation_id', true),'')::uuid)
    RETURNING event_id INTO v_id;
    RETURN v_id;
END $$;

-- ---------------------------------------------------------------------
-- 9.4 Re-point the CRUD trigger function to the unified stream
--     (triggers attached in part 6 keep working; only the body changes)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.fn_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_user bigint := NULLIF(current_setting('app.user_id',   true),'')::bigint;
    v_ip   inet   := NULLIF(current_setting('app.client_ip', true),'')::inet;
    v_sess text   := NULLIF(current_setting('app.session_id',true),'');
    v_co   bigint := NULLIF(current_setting('app.company_id',true),'')::bigint;
    v_type text; v_pk bigint; v_old jsonb; v_new jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_type := 'CREATE'; v_new := to_jsonb(NEW); v_pk := (v_new ->> TG_ARGV[0])::bigint;
    ELSIF TG_OP = 'UPDATE' THEN
        v_type := 'EDIT';   v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); v_pk := (v_new ->> TG_ARGV[0])::bigint;
    ELSE
        v_type := 'DELETE'; v_old := to_jsonb(OLD); v_pk := (v_old ->> TG_ARGV[0])::bigint;
    END IF;

    INSERT INTO audit.audit_event(
        event_type, app_user_id, client_ip, session_id, company_id,
        module, entity, entity_pk, old_value, new_value, result)
    VALUES (v_type, v_user, v_ip, v_sess, v_co,
        TG_TABLE_NAME, TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME, v_pk, v_old, v_new, 'SUCCESS');

    RETURN COALESCE(NEW, OLD);
END $$;

-- Retire the superseded tables (consolidated into audit_event)
DROP TABLE IF EXISTS audit.audit_log CASCADE;
DROP TABLE IF EXISTS audit.login_audit CASCADE;

-- ---------------------------------------------------------------------
-- 9.5 Tamper-evident integrity seals (periodic, chained, WORM-friendly)
-- ---------------------------------------------------------------------
CREATE TABLE audit.integrity_seal (
    seal_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    period_start   TIMESTAMPTZ NOT NULL,
    period_end     TIMESTAMPTZ NOT NULL,
    from_event     BIGINT,
    to_event       BIGINT,
    event_count    INT NOT NULL,
    chain_hash     BYTEA NOT NULL,
    prev_seal_hash BYTEA,
    sealed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sealed_by      BIGINT
);

CREATE OR REPLACE FUNCTION audit.seal_period(p_from timestamptz, p_to timestamptz)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
    v_prev bytea; v_run bytea; v_cnt int := 0;
    v_from bigint; v_to bigint; r audit.audit_event; v_id bigint;
BEGIN
    SELECT chain_hash INTO v_prev FROM audit.integrity_seal ORDER BY seal_id DESC LIMIT 1;
    v_run := coalesce(v_prev, '\x00'::bytea);
    FOR r IN SELECT * FROM audit.audit_event
             WHERE event_time >= p_from AND event_time < p_to ORDER BY event_id LOOP
        v_run := digest(v_run || audit.event_hash(r), 'sha256');
        v_cnt := v_cnt + 1;
        IF v_from IS NULL THEN v_from := r.event_id; END IF;
        v_to := r.event_id;
    END LOOP;
    INSERT INTO audit.integrity_seal(period_start, period_end, from_event, to_event,
        event_count, chain_hash, prev_seal_hash, sealed_by)
    VALUES (p_from, p_to, v_from, v_to, v_cnt, v_run, v_prev,
        NULLIF(current_setting('app.user_id', true),'')::bigint)
    RETURNING seal_id INTO v_id;
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION audit.verify_period(p_seal_id bigint)
RETURNS TABLE(is_valid boolean, first_bad_event bigint) LANGUAGE plpgsql AS $$
DECLARE s audit.integrity_seal; v_run bytea; r audit.audit_event; v_bad bigint;
BEGIN
    SELECT * INTO s FROM audit.integrity_seal WHERE seal_id = p_seal_id;
    v_run := coalesce(s.prev_seal_hash, '\x00'::bytea);
    FOR r IN SELECT * FROM audit.audit_event
             WHERE event_time >= s.period_start AND event_time < s.period_end ORDER BY event_id LOOP
        IF v_bad IS NULL AND r.row_hash IS DISTINCT FROM audit.event_hash(r) THEN
            v_bad := r.event_id;
        END IF;
        v_run := digest(v_run || audit.event_hash(r), 'sha256');
    END LOOP;
    is_valid := (v_run = s.chain_hash);
    first_bad_event := v_bad;
    RETURN NEXT;
END $$;

-- ---------------------------------------------------------------------
-- 9.6 Field-level diff (one row per changed field on EDIT events)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW audit.v_field_changes AS
SELECT e.event_id, e.event_time, e.app_user_id, e.entity, e.entity_pk,
       k.key AS field,
       e.old_value ->> k.key AS old_val,
       e.new_value ->> k.key AS new_val
FROM audit.audit_event e
CROSS JOIN LATERAL jsonb_object_keys(e.new_value) AS k(key)
WHERE e.event_type = 'EDIT'
  AND (e.old_value ->> k.key) IS DISTINCT FROM (e.new_value ->> k.key);

-- Convenience: per-user activity timeline
CREATE OR REPLACE VIEW audit.v_user_activity AS
SELECT event_time, event_type, username, app_user_id, host(client_ip) AS ip,
       module, entity, entity_pk, result, reason
FROM audit.audit_event;

-- ---------------------------------------------------------------------
-- 9.7 Grants -- append-only for the application
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON audit.audit_event, audit.integrity_seal TO erp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_event, audit.integrity_seal FROM erp_app;
GRANT SELECT ON audit.v_field_changes, audit.v_user_activity TO erp_app, erp_readonly;
GRANT EXECUTE ON FUNCTION audit.log_event(text,text,text,bigint,jsonb,jsonb,text,text,bigint,text,inet) TO erp_app;
GRANT EXECUTE ON FUNCTION audit.seal_period(timestamptz,timestamptz) TO erp_app;
GRANT EXECUTE ON FUNCTION audit.verify_period(bigint) TO erp_app, erp_readonly;

-- End Part 9 -- enterprise audit.
