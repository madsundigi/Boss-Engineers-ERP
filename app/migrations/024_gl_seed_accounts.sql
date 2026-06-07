-- =====================================================================
-- GL CHART-OF-ACCOUNTS SEED — the standard accounts the finance subledger
-- -> General Ledger auto-posting handlers (src/modules/gl/gl.handlers.ts)
-- reference by stable gl_code. When an AR invoice is posted, a customer
-- receipt is recorded, or a vendor invoice is approved, the outbox relay
-- posts a balanced double-entry journal that resolves these accounts by
-- code; if any are absent the handler throws (retry -> dead-letter), so this
-- seed is a hard prerequisite for that integration.
--
-- Scoped to company_code 'BE' (resolved to company_id). Idempotent:
-- ON CONFLICT (company_id, gl_code) DO NOTHING (the uq_gl unique in db/01),
-- so re-applying is a no-op and never disturbs existing accounts. account_type
-- values satisfy ck_gl_type (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE).
-- Apply AFTER the base schema (db/00_run_all.sql) and 019_gl.
-- =====================================================================

INSERT INTO mdm.gl_account (company_id, gl_code, gl_name, account_type, is_active)
SELECT c.company_id, a.gl_code, a.gl_name, a.account_type, true
FROM mdm.company c
JOIN (VALUES
    ('1000', 'Bank',                  'ASSET'),
    ('1200', 'Accounts Receivable',   'ASSET'),
    ('1410', 'GST Input Credit',      'ASSET'),
    ('2100', 'Accounts Payable',      'LIABILITY'),
    ('2110', 'GST Output Payable',    'LIABILITY'),
    ('4000', 'Project Revenue',       'INCOME'),
    ('5000', 'Project Cost (COGS)',   'EXPENSE')
) AS a(gl_code, gl_name, account_type) ON TRUE
WHERE c.company_code = 'BE'
ON CONFLICT (company_id, gl_code) DO NOTHING;

-- End migration 024_gl_seed_accounts.
