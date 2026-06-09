-- =====================================================================
-- Module M01 — Customer Enquiry : additional intake fields
-- Extends sales.enquiry (db/02 + migration 001) with 8 more optional
-- intake-capture fields from the product spec (lead detail snapshot).
-- All nullable: backward compatible — old code keeps running until redeploy.
-- Idempotent. Apply AFTER migration 001_enquiry.
-- =====================================================================

ALTER TABLE sales.enquiry
  ADD COLUMN IF NOT EXISTS mobile          VARCHAR(30),
  ADD COLUMN IF NOT EXISTS machine_type    VARCHAR(120),
  ADD COLUMN IF NOT EXISTS application     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS quantity        NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS budget          NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS sales_executive VARCHAR(120),
  ADD COLUMN IF NOT EXISTS follow_up_date  DATE,
  ADD COLUMN IF NOT EXISTS remarks         TEXT;

-- End migration 041_enquiry_intake_fields.
