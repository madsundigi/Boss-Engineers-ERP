/** Domain constants for the Failure Analysis module (M14): NCR -> RCA -> CAPA. */

/**
 * NCR (nonconformance) lifecycle. The base table qms.ncr (db/04) already ships a
 * `status` column with exactly these states (ck_ncr_status), so migration 016 does
 * NOT touch the CHECK — it only adds the branch + RLS plumbing.
 *   OPEN -> RCA -> CAPA -> CLOSED
 *     OPEN   — the nonconformance is raised (source + failure captured)
 *     RCA    — a root-cause analysis has been recorded (5WHY / FISHBONE / 8D)
 *     CAPA   — at least one corrective/preventive action has been recorded
 *     CLOSED — every CAPA's effectiveness is VERIFIED/CLOSED; the 8D is signed off
 * This is the classic quality 8D workflow: contain -> find the root cause ->
 * correct & prevent -> verify effectiveness -> close.
 */
export const NCR_STATUS = ['OPEN', 'RCA', 'CAPA', 'CLOSED'] as const;
export type NcrStatus = (typeof NCR_STATUS)[number];

/** Allowed NCR lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<NcrStatus, NcrStatus[]> = {
  OPEN: ['RCA'],
  RCA: ['CAPA'],
  CAPA: ['CLOSED'],
  CLOSED: [], // terminal
};

export function canTransition(from: NcrStatus, to: NcrStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** NCR source — where the nonconformance originated (mirrors ck_ncr_source, db/04). */
export const NCR_SOURCE = ['GRN', 'PRODUCTION', 'FAT', 'INSTALL', 'WARRANTY'] as const;
export type NcrSource = (typeof NCR_SOURCE)[number];

/** Root-cause-analysis method (mirrors qms.rca ck_rca_method, db/04). */
export const RCA_METHOD = ['5WHY', 'FISHBONE', '8D'] as const;
export type RcaMethod = (typeof RCA_METHOD)[number];

/** CAPA disposition type (mirrors qms.capa ck_capa_type, db/04). */
export const CAPA_TYPE = ['CORRECTIVE', 'PREVENTIVE'] as const;
export type CapaType = (typeof CAPA_TYPE)[number];

/** CAPA workflow status (mirrors qms.capa ck_capa_status, db/04). */
export const CAPA_STATUS = ['OPEN', 'IN_PROGRESS', 'VERIFIED', 'CLOSED'] as const;
export type CapaStatus = (typeof CAPA_STATUS)[number];

/** A CAPA is "settled" (effectiveness accounted for) when verified or closed. */
export const CAPA_SETTLED: CapaStatus[] = ['VERIFIED', 'CLOSED'];

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   QC                                = VCEDAX (the quality owner: edit RCA/CAPA,
 *                                       approve/close, delete, export),
 *   INSTALL/PRODUCTION/SERVICE/STORES = VC     (anyone on the floor can raise an NCR),
 *   ADMIN/CEO/FINANCE/PLANNING/PURCHASE = V    (view).
 * CREATE is broad (anyone can raise an NCR); EDIT/APPROVE/DELETE are QC-only, so
 * recording the analysis + actions and the closure verification gate are QC actions.
 */
export const FAILURE_PERMS = {
  VIEW: 'NCR_CAPA.VIEW',
  CREATE: 'NCR_CAPA.CREATE',
  EDIT: 'NCR_CAPA.EDIT',
  DELETE: 'NCR_CAPA.DELETE',
  APPROVE: 'NCR_CAPA.APPROVE',
  EXPORT: 'NCR_CAPA.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'NCR', pad 6). */
export const DOC_TYPE = 'NCR';

/**
 * Domain event emitted when an NCR is CLOSED (CAPA effectiveness verified, 8D
 * signed off). Downstream consumers feed the closed-loop quality KPIs and push
 * the failure-mode learning back to engineering / the failure-mode library.
 */
export const NCR_CLOSED_EVENT = 'ncr.closed';
