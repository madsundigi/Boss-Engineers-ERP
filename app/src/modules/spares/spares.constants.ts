/** Domain constants for the Spares Catalog & Service Inventory module (Tier-3 value-add).
 *
 * The after-sales spare-part master (svc.spare_part) and its per-location on-hand
 * balance (svc.spare_stock), supporting the Warranty & Service module (M13). A spare
 * part is an orderable component identified by a user-supplied part_code (unique per
 * company); each part carries a list price + a reorder level, and stock is tracked per
 * stocking location. There is NO base table for either — migration 032 CREATES both
 * and seeds the 'SPARE' RBAC domain (absent from the db/08 catalog). svc.spare_issue
 * (db/04) is a different record: it logs per-ticket consumption of a spare.
 */

/** Default stocking location used when a stock adjustment omits one. */
export const DEFAULT_LOCATION = 'MAIN';

/**
 * RBAC permission codes for this module (the 'SPARE' domain is seeded in migration
 * 032 — it is NOT in the db/08 catalog). Grants:
 *   SERVICE  = VCEDAX (own the catalog + stock: all six),
 *   STORES   = VCE    (view/create/edit — maintain catalog + adjust stock),
 *   PURCHASE = VC     (view/create — add parts to replenish),
 *   ADMIN    = VCEDAX (all six),
 *   CEO      = VX     (view + export),
 *   FINANCE  = V      (read only).
 * catalog create -> SPARE.CREATE; update / stock-adjust -> SPARE.EDIT;
 * reads -> SPARE.VIEW; soft-delete -> SPARE.DELETE; CSV export -> SPARE.EXPORT.
 * (APPROVE is seeded for SERVICE/ADMIN for forward compatibility; unused today.)
 */
export const SPARE_PERMS = {
  VIEW: 'SPARE.VIEW',
  CREATE: 'SPARE.CREATE',
  EDIT: 'SPARE.EDIT',
  DELETE: 'SPARE.DELETE',
  APPROVE: 'SPARE.APPROVE',
  EXPORT: 'SPARE.EXPORT',
} as const;
