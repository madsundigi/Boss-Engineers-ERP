/** Domain constants for the Vendor master-data module (mdm.vendor).
 *
 * The supplier master that procurement (PR/RFQ/PO) and AP build on. A vendor is a
 * supplier identified by a user-supplied vendor_code (globally UNIQUE — the DB
 * enforces a plain UNIQUE on vendor_code, NOT a per-company unique), carrying GST/PAN
 * tax identity, an MSME flag, an approval gate (is_approved — gates PO issue, A7), an
 * optional payment term, a 0–5 rating, and a lifecycle status. The table predates this
 * module (db/01_security_master.sql) and ships full audit columns + row_version +
 * is_deleted, so this is a standard soft-delete + optimistic-concurrency CRUD.
 */

/** Allowed vendor lifecycle states — ck_vendor_status in db/01. NOTE: 'BLACKLISTED',
 *  not 'BLOCKED'. ACTIVE = transactable; HOLD = temporarily suspended; BLACKLISTED =
 *  barred. */
export const VENDOR_STATUSES = ['ACTIVE', 'HOLD', 'BLACKLISTED'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/**
 * RBAC permission codes for this module. The 'VENDOR' domain is in the db/08 catalog
 * (every MODULE.ACTION is generated there). Grants of note:
 *   ADMIN    = VCEDX (full CRUD + export),
 *   PURCHASE = VCEX  (view/create/edit/export — onboard & maintain, NO delete),
 *   CEO/FINANCE = VX (view + export),
 *   STORES/QC/SERVICE = V (read only).
 * create -> VENDOR.CREATE; update -> VENDOR.EDIT; reads -> VENDOR.VIEW;
 * soft-delete -> VENDOR.DELETE.
 */
export const VENDOR_PERMS = {
  VIEW: 'VENDOR.VIEW',
  CREATE: 'VENDOR.CREATE',
  EDIT: 'VENDOR.EDIT',
  DELETE: 'VENDOR.DELETE',
} as const;
