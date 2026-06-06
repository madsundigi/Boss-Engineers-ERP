-- =====================================================================
-- Grants required once the app runs as the non-superuser `erp_app` role
-- (BUG-01 RLS fix). The base grant (db/06) gave erp_app SELECT/INSERT/UPDATE;
-- the app also hard-DELETEs CHILD rows it fully replaces (line items, cost
-- sheets, attachments). Parent documents keep soft-delete only (no DELETE
-- grant) — least privilege preserved on the documents themselves. Idempotent.
-- Apply AFTER 004.
-- =====================================================================

GRANT DELETE ON
    sales.quotation_line,
    sales.enquiry_line,
    sales.enquiry_attachment,
    sales.cost_sheet,
    sales.cost_sheet_line
TO erp_app;

-- End migration 005_rls_role_grants.
