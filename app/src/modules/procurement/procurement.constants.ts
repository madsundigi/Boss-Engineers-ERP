/** Domain constants for the Procurement module (M05 — PR / PO / GRN). */

// ---------------------------------------------------------------------------
// Lifecycles (mirror the base scm.* check-constraints in db/03_hcm_mfg_scm.sql)
// ---------------------------------------------------------------------------

/** Purchase-requisition lifecycle (scm.purchase_requisition.status). */
export const PR_STATUS = ['DRAFT', 'PENDING', 'APPROVED', 'PO_CREATED', 'CANCELLED'] as const;
export type PrStatus = (typeof PR_STATUS)[number];

/** Purchase-order lifecycle (scm.purchase_order.status). */
export const PO_STATUS = ['DRAFT', 'PENDING', 'APPROVED', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;
export type PoStatus = (typeof PO_STATUS)[number];

/** Goods-receipt lifecycle (scm.goods_receipt.status). */
export const GRN_STATUS = ['DRAFT', 'POSTED', 'QC_PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type GrnStatus = (typeof GRN_STATUS)[number];

/** Document types registered in the numbering engine (db/07_numbering.sql). */
export const DOC_TYPE = { PR: 'PR', PO: 'PO', GRN: 'GRN' } as const;

// ---------------------------------------------------------------------------
// RBAC permission codes (mirror sec.permission: modules PURCHASE_REQ /
// PURCHASE_ORDER / GRN — db/08_rbac.sql).
// ---------------------------------------------------------------------------

export const PR_PERMS = {
  VIEW: 'PURCHASE_REQ.VIEW',
  CREATE: 'PURCHASE_REQ.CREATE',
  EDIT: 'PURCHASE_REQ.EDIT',
  DELETE: 'PURCHASE_REQ.DELETE',
  APPROVE: 'PURCHASE_REQ.APPROVE',
  EXPORT: 'PURCHASE_REQ.EXPORT',
} as const;

export const PO_PERMS = {
  VIEW: 'PURCHASE_ORDER.VIEW',
  CREATE: 'PURCHASE_ORDER.CREATE',
  EDIT: 'PURCHASE_ORDER.EDIT',
  DELETE: 'PURCHASE_ORDER.DELETE',
  APPROVE: 'PURCHASE_ORDER.APPROVE',
  EXPORT: 'PURCHASE_ORDER.EXPORT',
} as const;

export const GRN_PERMS = {
  VIEW: 'GRN.VIEW',
  CREATE: 'GRN.CREATE',
  EDIT: 'GRN.EDIT',
  DELETE: 'GRN.DELETE',
  APPROVE: 'GRN.APPROVE',
  EXPORT: 'GRN.EXPORT',
} as const;

/** Domain event emitted on PO approval for downstream commitment / profitability. */
export const PO_APPROVED_EVENT = 'po.approved';
export const PO_AGGREGATE = 'PURCHASE_ORDER';
