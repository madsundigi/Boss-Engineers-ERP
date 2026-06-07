/** Domain constants for the Inventory & Critical Items module (M06). */

/** Stock-adjustment document type. RECEIPT/ADJUST add stock; WRITE_OFF removes it. */
export const ADJUSTMENT_TYPE = ['RECEIPT', 'WRITE_OFF', 'ADJUST'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPE)[number];

/** Stock-adjustment lifecycle. */
export const ADJUSTMENT_STATUS = ['DRAFT', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUS)[number];

/** Signed ledger transaction types (scm.stock_transaction.txn_type). */
export const STOCK_TXN_TYPE = ['GRN', 'ISSUE', 'RETURN', 'ADJUST', 'TRANSFER', 'RESERVE'] as const;
export type StockTxnType = (typeof STOCK_TXN_TYPE)[number];

/** ref_doc_type tags written to the immutable ledger. */
export const REF_DOC = {
  ADJUSTMENT: 'STOCK_ADJ',
  RESERVATION: 'RESERVATION',
  ISSUE: 'MATERIAL_ISSUE',
} as const;

/** Critical-item reasons / status (scm.critical_item). */
export const CRITICAL_REASON = ['LONG_LEAD', 'SINGLE_SOURCE', 'HIGH_VALUE', 'IMPORT'] as const;
export type CriticalReason = (typeof CRITICAL_REASON)[number];

export const CRITICAL_STATUS = ['OPEN', 'ORDERED', 'RECEIVED', 'AT_RISK'] as const;
export type CriticalStatus = (typeof CRITICAL_STATUS)[number];

/** RBAC permission codes for this module (mirror sec.permission, module=INVENTORY). */
export const INVENTORY_PERMS = {
  VIEW: 'INVENTORY.VIEW',
  CREATE: 'INVENTORY.CREATE',
  EDIT: 'INVENTORY.EDIT',
  DELETE: 'INVENTORY.DELETE',
  APPROVE: 'INVENTORY.APPROVE',
  EXPORT: 'INVENTORY.EXPORT',
} as const;
