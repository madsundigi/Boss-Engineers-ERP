-- =====================================================================
-- Module M02 — Quotation : incremental migration
-- Extends base sales.quotation (db/02) for: lead snapshot (quote a lead that
-- has no customer master yet), discount, branch (numbering), approval + send
-- tracking, and a REJECTED status. Revisions/lines/cost-sheet already exist.
-- Audit + status-history triggers already attached in db/06. Idempotent.
-- =====================================================================

ALTER TABLE sales.quotation
  ADD COLUMN IF NOT EXISTS bu_id           BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS subject         VARCHAR(200),
  ADD COLUMN IF NOT EXISTS customer_name   VARCHAR(160),
  ADD COLUMN IF NOT EXISTS contact_person  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS email           VARCHAR(160),
  ADD COLUMN IF NOT EXISTS currency_code   VARCHAR(3)  NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS discount_pct    NUMERIC(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submitted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by    BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS decided_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_by      BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS decision_reason VARCHAR(300),
  ADD COLUMN IF NOT EXISTS sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_to         VARCHAR(160),
  ADD COLUMN IF NOT EXISTS pdf_ref         VARCHAR(400);

-- A quotation may be raised for a lead before a customer master record exists.
ALTER TABLE sales.quotation ALTER COLUMN customer_id  DROP NOT NULL;
ALTER TABLE sales.quotation ALTER COLUMN currency_id  DROP NOT NULL;

-- A captured customer name is required (intake identity / PDF header).
UPDATE sales.quotation SET customer_name = 'UNKNOWN' WHERE customer_name IS NULL;
ALTER TABLE sales.quotation ALTER COLUMN customer_name SET NOT NULL;

-- Add REJECTED to the lifecycle.
ALTER TABLE sales.quotation DROP CONSTRAINT IF EXISTS ck_quote_status;
ALTER TABLE sales.quotation ADD CONSTRAINT ck_quote_status CHECK (status IN
  ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','SENT','NEGOTIATION','WON','LOST'));

-- Email format guard (defence in depth).
ALTER TABLE sales.quotation DROP CONSTRAINT IF EXISTS ck_quote_email;
ALTER TABLE sales.quotation ADD CONSTRAINT ck_quote_email
  CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Discount sanity.
ALTER TABLE sales.quotation DROP CONSTRAINT IF EXISTS ck_quote_discount;
ALTER TABLE sales.quotation ADD CONSTRAINT ck_quote_discount
  CHECK (discount_pct >= 0 AND discount_pct <= 100);

CREATE INDEX IF NOT EXISTS ix_quotation_company_status ON sales.quotation(company_id, status);

-- End migration 002_quotation.
