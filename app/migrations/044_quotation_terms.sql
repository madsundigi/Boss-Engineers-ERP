-- =====================================================================
-- Module M02 — Quotation : commercial terms fields
-- Extends sales.quotation (db/02 + migration 002) with 4 more optional
-- header fields from the product spec: tax %, delivery / payment / warranty
-- terms (commercial-offer detail for the PDF and customer negotiation).
-- All nullable: backward compatible — old code keeps running until redeploy.
-- Idempotent. Apply AFTER migration 002_quotation.
-- =====================================================================

ALTER TABLE sales.quotation
  ADD COLUMN IF NOT EXISTS tax_pct        NUMERIC(9,4),
  ADD COLUMN IF NOT EXISTS delivery_terms VARCHAR(200),
  ADD COLUMN IF NOT EXISTS payment_terms  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS warranty_terms VARCHAR(200);

-- End migration 044_quotation_terms.
