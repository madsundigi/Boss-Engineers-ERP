-- =====================================================================
-- Module M13 — Warranty & Service : KPI capture fields
-- Adds the two facts the service KPIs need that the base table (db/04 +
-- migration 015) does not yet carry:
--   * resolved_at  — when the fault was fixed (status -> RESOLVED); powers
--                    MTTR (resolved_at - reported_at) and SLA compliance
--                    (resolved_at <= sla_due_at).
--   * csat_rating  — post-service customer satisfaction score, 1..5; powers
--                    CSAT average. NULL = not yet rated.
-- (First-Time-Fix is derived from svc.field_visit counts — no column needed.)
-- Both nullable: backward compatible — old rows + old code keep running.
-- Idempotent. Apply AFTER migration 015_service.
-- =====================================================================

ALTER TABLE svc.service_ticket
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS csat_rating SMALLINT;

-- Re-assert the CSAT bound idempotently (drop-then-add so re-runs never error).
ALTER TABLE svc.service_ticket DROP CONSTRAINT IF EXISTS ck_ticket_csat;
ALTER TABLE svc.service_ticket ADD CONSTRAINT ck_ticket_csat
  CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5);

-- Partial index for the resolved-window KPI aggregates (MTTR / SLA / FTF scan
-- only resolved rows per company).
CREATE INDEX IF NOT EXISTS ix_ticket_company_resolved
  ON svc.service_ticket(company_id, resolved_at) WHERE resolved_at IS NOT NULL;

-- End migration 042_service_kpis.
