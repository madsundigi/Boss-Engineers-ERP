-- =====================================================================
-- Boss Engineers ERP  |  Master run script
-- Usage:  psql -v ON_ERROR_STOP=1 -d boss_engineers_erp -f db/00_run_all.sql
-- Run from the repo root so the relative \ir paths resolve.
-- =====================================================================
\set ON_ERROR_STOP on

\echo '== Part 1/6 : security + master data =='
\ir 01_security_master.sql

\echo '== Part 2/6 : sales + project =='
\ir 02_sales_project.sql

\echo '== Part 3/6 : hcm + production + supply chain =='
\ir 03_hcm_mfg_scm.sql

\echo '== Part 4/6 : quality + logistics + service =='
\ir 04_qms_log_svc.sql

\echo '== Part 5/6 : finance + audit + reporting =='
\ir 05_fin_audit_rpt.sql

\echo '== Part 6/6 : deferred FKs + automation + triggers + seed + roles + MVs =='
\ir 06_constraints_automation.sql

\echo '== Part 7 : document numbering engine =='
\ir 07_numbering.sql

\echo '== Part 8 : RBAC (roles, permissions, grants, SoD) =='
\ir 08_rbac.sql

\echo '== Boss Engineers ERP schema build complete =='
