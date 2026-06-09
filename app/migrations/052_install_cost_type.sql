-- =====================================================================
-- Module M15 — Project Profitability : add INSTALLATION cost type
-- Widens the cost_type CHECK on fin.project_cost_ledger (db/05_fin_audit_rpt.sql,
-- constraint ck_cost_type2) to admit 'INSTALLATION' so project cost can be broken
-- down by category — Material, Labour, Freight, Installation, Warranty (spec:
-- cost-by-category profitability). Existing values are unchanged; INSTALLATION is
-- added on top. The constraint is dropped + recreated by its REAL name (ck_cost_type2).
-- Idempotent. Apply AFTER db/05 (and migration 023_profitability).
-- =====================================================================

ALTER TABLE fin.project_cost_ledger
  DROP CONSTRAINT IF EXISTS ck_cost_type2;

ALTER TABLE fin.project_cost_ledger
  ADD CONSTRAINT ck_cost_type2
  CHECK (cost_type IN ('MATERIAL','LABOUR','SUBCON','FREIGHT','OVERHEAD','WARRANTY','INSTALLATION'));

-- End migration 052_install_cost_type.
