-- =====================================================================
-- Transactional Outbox (QA BW-01/BW-02/CC-01)
-- An event is inserted in the SAME transaction as the business state change,
-- so state + intent commit atomically. A relay then dispatches events to
-- handlers (e.g. send the quotation email) AFTER commit, with retry + backoff
-- and dead-lettering. Lives in mdm (erp_app already has table privileges there).
-- Idempotent. Apply AFTER 003.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mdm.outbox_event (
    event_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type     VARCHAR(60)  NOT NULL,           -- e.g. 'quotation.sent'
    aggregate_type VARCHAR(40)  NOT NULL,           -- e.g. 'QUOTATION'
    aggregate_id   BIGINT,
    company_id     BIGINT,
    payload        JSONB        NOT NULL DEFAULT '{}',
    status         VARCHAR(12)  NOT NULL DEFAULT 'PENDING',
    attempts       INT          NOT NULL DEFAULT 0,
    max_attempts   INT          NOT NULL DEFAULT 5,
    available_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),  -- for retry backoff
    last_error     TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by     BIGINT,
    processed_at   TIMESTAMPTZ,
    CONSTRAINT ck_outbox_status CHECK (status IN ('PENDING','PROCESSED','DEAD'))
);

-- Relay poll index (only the rows it scans).
CREATE INDEX IF NOT EXISTS ix_outbox_poll
    ON mdm.outbox_event (available_at, event_id) WHERE status = 'PENDING';

-- Explicit grants (belt-and-suspenders alongside the mdm default privileges).
GRANT SELECT, INSERT, UPDATE ON mdm.outbox_event TO erp_app;

-- End migration 004_outbox.
