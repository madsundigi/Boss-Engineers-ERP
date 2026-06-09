/**
 * Domain constants for the Work-Centre master (M08 production capacity).
 *
 * mdm.work_center (db/01_security_master.sql) is a production resource: a place where
 * routing operations are performed, with a daily capacity and an hourly cost rate. It
 * is identified by a user-supplied wc_code (globally UNIQUE) and belongs to a business
 * unit (bu_id) — there is NO company_id on the row, so tenant scoping is done by joining
 * mdm.business_unit (bu.company_id = ctx.companyId).
 *
 * The table has NO row_version / is_deleted / audit columns, so this module skips
 * optimistic concurrency and uses a HARD delete (adapted to the real schema).
 */

/**
 * RBAC permission codes. No WORK_CENTER domain exists in db/08_rbac.sql, so this module
 * reuses the WORK_ORDER domain — work centres are production resources owned by the same
 * roles (PRODUCTION = VCEDAX, PLANNING = VC, CEO/STORES/QC/FINANCE = V/VX). reads ->
 * WORK_ORDER.VIEW; create -> WORK_ORDER.CREATE; update -> WORK_ORDER.EDIT;
 * delete -> WORK_ORDER.DELETE.
 */
export const WORK_CENTER_PERMS = {
  VIEW: 'WORK_ORDER.VIEW',
  CREATE: 'WORK_ORDER.CREATE',
  EDIT: 'WORK_ORDER.EDIT',
  DELETE: 'WORK_ORDER.DELETE',
} as const;
