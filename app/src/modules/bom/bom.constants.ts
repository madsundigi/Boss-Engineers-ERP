/** Domain constants for the Engineering / Bill of Materials module (BOM). */

/**
 * BOM lifecycle. The base table mdm.bom_header (db/01) ships a `status` column
 * already constrained to these three states (ck_bom_status):
 *   DRAFT     -> (engineering sign-off) -> RELEASED -> (superseded) -> OBSOLETE
 * A BOM is editable only in DRAFT; RELEASED is the engineering-approved baseline
 * consumed downstream (planning / production), and OBSOLETE is terminal — a newer
 * revision has replaced it. RELEASE emits 'bom.released'.
 */
export const BOM_STATUS = ['DRAFT', 'RELEASED', 'OBSOLETE'] as const;
export type BomStatus = (typeof BOM_STATUS)[number];

/** Engineering (EBOM) vs Manufacturing (MBOM) bill — the base ck_bom_type set. */
export const BOM_TYPE = ['EBOM', 'MBOM'] as const;
export type BomType = (typeof BOM_TYPE)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<BomStatus, BomStatus[]> = {
  DRAFT: ['RELEASED'],
  RELEASED: ['OBSOLETE'],
  OBSOLETE: [], // terminal
};

export function canTransition(from: BomStatus, to: BomStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   ADMIN              = VCEDX (full),
 *   PLANNING/PRODUCTION = VCE  (create/edit),
 *   CEO/PURCHASE/QC/SERVICE = V (read).
 * There is NO BOM.APPROVE grant, so release/obsolete are guarded by BOM.EDIT.
 */
export const BOM_PERMS = {
  VIEW: 'BOM.VIEW',
  CREATE: 'BOM.CREATE',
  EDIT: 'BOM.EDIT',
  DELETE: 'BOM.DELETE',
  EXPORT: 'BOM.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'BOM', pad 6). */
export const DOC_TYPE = 'BOM';

/**
 * Domain event emitted when a BOM is RELEASED (engineering baseline frozen).
 * Downstream consumers (planning / production / costing) react to the baseline.
 */
export const BOM_RELEASED_EVENT = 'bom.released';
