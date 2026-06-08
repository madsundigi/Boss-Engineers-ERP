/** Domain constants for the Plant Maintenance module (Tier-3 value-add).
 *
 * Two aggregates: the own-asset / tooling register (maint.asset) and the
 * maintenance work orders raised against it (maint.work_order). An asset is a
 * maintainable machine / tool / vehicle / instrument; a maintenance work order
 * (MWO) is a PREVENTIVE / BREAKDOWN / CALIBRATION job against one asset, branch-
 * numbered via mdm.next_document_no(...,'MWO'). There is NO base table for either —
 * migration 033 CREATES the new 'maint' schema + both tables and seeds the
 * 'MAINTENANCE' RBAC domain (absent from the db/08 catalog).
 */

// ---------------------------------------------------------------------
// Asset register
// ---------------------------------------------------------------------

/** Asset kind (maint.asset.asset_type). Mirrors the CHECK in migration 033. */
export const ASSET_TYPE = ['MACHINE', 'TOOL', 'VEHICLE', 'INSTRUMENT', 'OTHER'] as const;
export type AssetType = (typeof ASSET_TYPE)[number];

/**
 * Asset status (maint.asset.status):
 *   ACTIVE -> UNDER_MAINTENANCE (set when a work order starts) -> ACTIVE (on
 *   completion); RETIRED is the terminal end-of-life state. The work-order
 *   lifecycle drives ACTIVE <-> UNDER_MAINTENANCE; setStatus exposes RETIRED.
 */
export const ASSET_STATUS = ['ACTIVE', 'UNDER_MAINTENANCE', 'RETIRED'] as const;
export type AssetStatus = (typeof ASSET_STATUS)[number];

// ---------------------------------------------------------------------
// Maintenance work order (MWO)
// ---------------------------------------------------------------------

/** Maintenance work-order type (maint.work_order.wo_type). */
export const WO_TYPE = ['PREVENTIVE', 'BREAKDOWN', 'CALIBRATION'] as const;
export type WoType = (typeof WO_TYPE)[number];

/**
 * Work-order lifecycle (maint.work_order.status):
 *   OPEN -> IN_PROGRESS -> DONE   (+ CANCELLED, reachable from OPEN or IN_PROGRESS)
 * A WO is raised OPEN; start moves it to IN_PROGRESS (and the asset to
 * UNDER_MAINTENANCE); complete moves it to DONE (sets completed_date, returns the
 * asset to ACTIVE and emits 'maintenance.completed'); cancel abandons an open job.
 * DONE and CANCELLED are terminal.
 */
export const WO_STATUS = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type WoStatus = (typeof WO_STATUS)[number];

/** Allowed work-order lifecycle transitions. Deny anything not listed. */
export const WO_STATUS_TRANSITIONS: Record<WoStatus, WoStatus[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'CANCELLED'],
  DONE: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransitionWo(from: WoStatus, to: WoStatus): boolean {
  return WO_STATUS_TRANSITIONS[from].includes(to);
}

/** Document-numbering type registered in mdm.numbering_rule (prefix 'MWO'). */
export const DOC_TYPE = 'MWO';

/**
 * RBAC permission codes for this module (the 'MAINTENANCE' domain is seeded in
 * migration 033 — it is NOT in the db/08 catalog). Grants:
 *   PRODUCTION = VCEDA  (run the register + work orders: view/create/edit/delete/approve),
 *   STORES     = VCE    (maintain assets: view/create/edit),
 *   ADMIN      = VCEDAX (all six),
 *   CEO        = VX     (view + export),
 *   FINANCE    = V      (read only),
 *   QC         = VC     (view + create — calibration WOs).
 * asset / WO create -> MAINTENANCE.CREATE; update + lifecycle transitions ->
 * MAINTENANCE.EDIT; reads -> MAINTENANCE.VIEW; soft-delete -> MAINTENANCE.DELETE;
 * CSV export -> MAINTENANCE.EXPORT.
 */
export const MAINTENANCE_PERMS = {
  VIEW: 'MAINTENANCE.VIEW',
  CREATE: 'MAINTENANCE.CREATE',
  EDIT: 'MAINTENANCE.EDIT',
  DELETE: 'MAINTENANCE.DELETE',
  APPROVE: 'MAINTENANCE.APPROVE',
  EXPORT: 'MAINTENANCE.EXPORT',
} as const;

/**
 * Domain event emitted when a maintenance work order is COMPLETED (atomically with
 * the status change via the transactional outbox). Payload:
 *   { mwoNo, assetId, woType }.
 * Downstream consumers (asset availability / OEE / maintenance dashboards) react to
 * a maintenance job finishing and the asset returning to service.
 */
export const MAINTENANCE_COMPLETED_EVENT = 'maintenance.completed';
