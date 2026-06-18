-- =====================================================================
-- Enquiry — drop the dead `qualification` column.
--
-- sales.enquiry historically carried TWO status-like columns: `status` — the
-- real lead lifecycle (NEW -> QUALIFIED -> QUOTED -> CONVERTED | LOST | ON_HOLD,
-- set by migration 001) — AND `qualification` (default 'NEW', CHECK
-- NEW/QUALIFIED/LOST). The application code only ever reads/writes `status`;
-- `qualification` is never touched, so it is removed to avoid confusion.
--
-- DROP COLUMN auto-drops its single-column CHECK (ck_enq_qual). Idempotent and
-- safe on live — the column only ever held its 'NEW' default.
-- =====================================================================

ALTER TABLE sales.enquiry DROP COLUMN IF EXISTS qualification;

-- End migration 055_enquiry_drop_qualification.
