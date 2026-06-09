-- =====================================================================
-- Module M13 — Warranty & Service : complaint detail
-- Extends svc.service_ticket (db/04 + migrations 015/042) with the
-- free-text complaint/symptom captured when the ticket is logged:
--   * complaint — the reported fault description (what the customer
--                 reported); NULL = not captured.
-- Nullable: backward compatible — old rows + old code keep running.
-- (Service Cost is derived from svc.field_visit.travel_cost +
-- svc.spare_issue.qty*unit_cost at read time — no column needed.)
-- Idempotent. Apply AFTER migration 015_service.
-- =====================================================================

ALTER TABLE svc.service_ticket
  ADD COLUMN IF NOT EXISTS complaint TEXT;

-- End migration 050_ticket_complaint.
