-- =====================================================================
-- Module — Customer / Vendor Portal (FRD §11, Tier-3) : incremental migration
-- A self-service, READ-MOSTLY surface for EXTERNAL users. A portal user is an
-- sec.app_user LINKED to exactly one trading partner via the new nullable
-- customer_id / vendor_id columns: a customer-linked user sees ONLY their own
-- projects / dispatches / invoices / tickets (and may raise a ticket); a
-- vendor-linked user sees ONLY their own POs / GRNs / payments (and may
-- acknowledge a PO). The module owns NO base table — it READS existing
-- company-scoped tables through the erp_app RLS role, additionally filtered by the
-- caller's customer_id / vendor_id. Its only writes are an INSERT into
-- svc.service_ticket (raise-ticket) and an UPDATE of scm.purchase_order (ack).
--
-- This migration therefore:
--   1. seeds the 'PORTAL' RBAC domain (absent from db/08) + its role grants,
--   2. LINKAGE: adds sec.app_user.customer_id / vendor_id (nullable FKs) — how an
--      external user is bound to the one partner whose data they may see,
--   3. ACK: adds scm.purchase_order.acknowledged_at / acknowledged_by (additive)
--      and grants erp_app UPDATE on scm.purchase_order for the ack endpoint.
-- It creates NO new tables and NO new RLS of its own (it reads existing
-- company-scoped tables). The 'SERVICE_TICKET' numbering rule (db/07) and the
-- SERVICE_TICKET RBAC domain (db/08) already exist, so they are NOT re-seeded.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 039.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'PORTAL' permission domain (db/08 has no such module) and
--    grant it to roles. ADMIN holds all six (VCEDAX); SALES / SERVICE / PURCHASE
--    get view+create (VC — they own the partner relationship and field the
--    raise-ticket / acknowledge actions); CEO views only (V). perm_code is
--    'PORTAL.<ACTION>'. Mirrors the 029 flag-letter LATERAL-join idiom.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'PORTAL.'||a,'PORTAL',a,a||' on PORTAL' FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES ('ADMIN','VCEDAX'),('SALES','VC'),('SERVICE','VC'),('PURCHASE','VC'),('CEO','V')) g(role_code,flags)
JOIN sec.role r ON r.role_code=g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter,action) ON position(f.letter in g.flags)>0
JOIN sec.permission p ON p.module='PORTAL' AND p.action=f.action ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. LINKAGE — bind a portal app_user to exactly one trading partner. Both columns
--    are NULLABLE: an internal (non-portal) user has both NULL; an external user
--    has exactly one set. The portal endpoints auto-scope to whichever is set (and
--    403 a caller with neither). Additive + guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
ALTER TABLE sec.app_user
  ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES mdm.customer(customer_id),
  ADD COLUMN IF NOT EXISTS vendor_id   BIGINT REFERENCES mdm.vendor(vendor_id);

CREATE INDEX IF NOT EXISTS ix_app_user_customer ON sec.app_user(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_app_user_vendor   ON sec.app_user(vendor_id)   WHERE vendor_id   IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. PO ACKNOWLEDGEMENT — a vendor portal user acknowledges receipt of a PO. Two
--    additive columns stamped by the ack endpoint (only for the caller's own
--    vendor's PO). acknowledged_by references the acting app_user. Guarded.
-- ---------------------------------------------------------------------
ALTER TABLE scm.purchase_order
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by BIGINT REFERENCES sec.app_user(user_id);

-- ---------------------------------------------------------------------
-- 4. GRANT. erp_app already holds SELECT/INSERT/UPDATE on the schemas the portal
--    reads (db/06), so no read grants are needed. Re-assert UPDATE on
--    scm.purchase_order for the acknowledge endpoint (idempotent — least surprise).
-- ---------------------------------------------------------------------
GRANT UPDATE ON scm.purchase_order TO erp_app;

-- End migration 040_portal.
