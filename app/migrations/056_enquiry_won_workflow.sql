-- =====================================================================
-- Enquiry — WON lifecycle + Project auto-seed link.
--
-- The enquiry now OWNS its own deal outcome (it no longer borrows the
-- quotation's). The lifecycle becomes:
--   NEW -> QUALIFIED -> QUOTED -> (REVISE_QUOTED <-> QUOTED) -> WON | LOST
-- with ON_HOLD as a pause from any active stage. CONVERTED is RETIRED and
-- folded into WON; REVISE_QUOTED + WON are introduced.
--
-- Reaching WON fires an 'enquiry.won' outbox event whose handler seeds a
-- Project FROM the enquiry — mirroring the quotation.won -> project path.
-- proj.project.enquiry_id is the idempotency/traceability link for that seed.
--
-- Idempotent. Apply AFTER migration 001_enquiry (which set ck_enq_status to the
-- old 6-status domain) and the base schema (db/00_run_all.sql).
-- =====================================================================

-- 1. Migrate retired data: every CONVERTED enquiry is now WON.
UPDATE sales.enquiry SET status = 'WON' WHERE status = 'CONVERTED';

-- 2. Replace the status CHECK with the 7 new statuses (drops CONVERTED,
--    adds REVISE_QUOTED + WON). Drop-then-add so re-runs converge.
ALTER TABLE sales.enquiry DROP CONSTRAINT IF EXISTS ck_enq_status;
ALTER TABLE sales.enquiry ADD CONSTRAINT ck_enq_status
  CHECK (status IN ('NEW','QUALIFIED','QUOTED','REVISE_QUOTED','WON','LOST','ON_HOLD'));

-- 3. Project -> Enquiry link: the source enquiry a project was auto-seeded from.
--    Nullable (projects can still originate from a won quotation, or be created
--    directly). The index backs the handler's idempotency probe + traceability.
ALTER TABLE proj.project
  ADD COLUMN IF NOT EXISTS enquiry_id BIGINT REFERENCES sales.enquiry(enquiry_id);
CREATE INDEX IF NOT EXISTS ix_project_enquiry ON proj.project(enquiry_id);

-- End migration 056_enquiry_won_workflow.
