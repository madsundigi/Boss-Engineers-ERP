/** Domain constants for the Item (material/product) master-data module.
 *
 * The item master (mdm.item, defined in db/01_security_master.sql) is the company
 * catalog of every material, bought-out part, semi-finished/finished good, service
 * and spare. An item is identified by a user-supplied item_code (the DB enforces a
 * UNIQUE constraint; the service maps the 23505 to a 409) and is classified by an
 * item_type and an item_category. mdm.item is master data: it has NO Row-Level
 * Security policy, but it DOES carry a company_id, so every query in this module
 * filters by ctx.companyId explicitly (the runInContext/runRead helpers still drop
 * to the erp_app role + push the identity GUCs for the audit triggers).
 */

/**
 * The item_type domain (CHECK ck_item_type on mdm.item). RAW = raw material,
 * BOUGHT_OUT = purchased component, SEMI_FIN = work-in-progress assembly,
 * FINISHED = sellable end product, SERVICE = a non-stock service line,
 * SPARE = after-sales spare part.
 */
export const ITEM_TYPES = ['RAW', 'BOUGHT_OUT', 'SEMI_FIN', 'FINISHED', 'SERVICE', 'SPARE'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * RBAC permission codes for this module (the 'ITEM' domain is seeded in db/08_rbac.sql).
 * Grants: ADMIN = VCEDX (full), STORES/PLANNING = VCE (maintain the catalog),
 * CEO = VX (view + export), everyone else (SALES/PURCHASE/PRODUCTION/QC/SERVICE/
 * FINANCE) = V (read only). reads -> ITEM.VIEW; create -> ITEM.CREATE;
 * update -> ITEM.EDIT; soft-delete -> ITEM.DELETE.
 */
export const ITEM_PERMS = {
  VIEW: 'ITEM.VIEW',
  CREATE: 'ITEM.CREATE',
  EDIT: 'ITEM.EDIT',
  DELETE: 'ITEM.DELETE',
} as const;
