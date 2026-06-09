-- =====================================================================
-- Module M12 — Installation & Commissioning : site engineer + progress
-- Extends svc.installation (db/04 + migration 014) with two optional
-- field-execution facts from the product spec:
--   * site_engineer_id — the field engineer who owns the on-site install
--                        (FK sec.app_user; NULL = unassigned).
--   * progress_pct     — percent-complete of the on-site work, 0..100;
--                        NULL = not yet reported.
-- Both nullable: backward compatible — old rows + old code keep running.
-- Idempotent. Apply AFTER migration 014_installation.
-- =====================================================================

ALTER TABLE svc.installation
  ADD COLUMN IF NOT EXISTS site_engineer_id BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS progress_pct     NUMERIC(5,2);

-- Re-assert the progress bound idempotently (drop-then-add so re-runs never error).
ALTER TABLE svc.installation DROP CONSTRAINT IF EXISTS ck_install_progress;
ALTER TABLE svc.installation ADD CONSTRAINT ck_install_progress
  CHECK (progress_pct IS NULL OR progress_pct BETWEEN 0 AND 100);

-- End migration 049_install_progress.
