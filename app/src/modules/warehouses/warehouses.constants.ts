/** Domain constants for the Warehouse master-data module (mdm.warehouse).
 *
 * A warehouse is an inventory location that belongs to a business unit (bu_id ->
 * mdm.business_unit), NOT directly to a company. The table (db/01_security_master.sql)
 * is deliberately minimal:
 *   warehouse_id (identity), bu_id (FK, required), wh_code (required),
 *   wh_name (required), is_active (default true).
 * It carries NO company_id, NO audit columns, NO row_version, and NO is_deleted. This
 * module therefore ADAPTS the spares CRUD template:
 *   - tenant scoping is via a JOIN to mdm.business_unit (bu.company_id = ctx.companyId),
 *     since the warehouse row itself has no company_id;
 *   - there is NO optimistic concurrency (no row_version) — PATCH is a plain update;
 *   - DELETE is a HARD delete (no is_deleted column); a warehouse referenced by stock
 *     rows is protected by the FK (23503), which the service maps to a 409.
 * The UNIQUE key is (bu_id, wh_code) — a code is unique within its business unit.
 *
 * RBAC reuses the INVENTORY domain (warehouses are inventory locations; no WAREHOUSE
 * domain exists in the db/08 catalog). Grants of note: STORES = VCEDAX (full CRUD),
 * ADMIN/most roles = V (read only), CEO/FINANCE include export.
 */
export const WAREHOUSE_PERMS = {
  VIEW: 'INVENTORY.VIEW',
  CREATE: 'INVENTORY.CREATE',
  EDIT: 'INVENTORY.EDIT',
  DELETE: 'INVENTORY.DELETE',
} as const;
