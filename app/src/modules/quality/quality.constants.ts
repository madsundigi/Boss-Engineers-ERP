/** Domain constants for the QMS — Quality Inspection & Gauge Calibration module. */

/**
 * Inspection lifecycle. The base table qms.inspection (db/04) ships a `result`
 * column (PASS/FAIL/PARTIAL) but no workflow `status`; migration 026 adds a
 * `status` column with this lifecycle so an inspection can be raised, then have
 * its results recorded:
 *   PENDING -> PASS | FAIL | PARTIAL
 *     PENDING — the inspection is raised (source doc + parameter lines captured)
 *     PASS    — every sampled line accepted, overall result PASS
 *     FAIL    — at least one line rejected and the overall call is FAIL (emits
 *               'inspection.failed' so a downstream NCR can be raised)
 *     PARTIAL — mixed accept/reject, conditionally accepted / sorted
 * PASS / FAIL / PARTIAL are terminal: results are recorded once.
 */
export const INSPECTION_STATUS = ['PENDING', 'PASS', 'FAIL', 'PARTIAL'] as const;
export type InspectionStatus = (typeof INSPECTION_STATUS)[number];

/** The overall result an inspection can resolve to (mirrors ck_insp_result, db/04). */
export const INSPECTION_RESULT = ['PASS', 'FAIL', 'PARTIAL'] as const;
export type InspectionResult = (typeof INSPECTION_RESULT)[number];

/**
 * Inspection type (mirrors ck_insp_type, db/04): the stage at which quality is
 * checked — incoming (GRN), in-process (work order), or final.
 */
export const INSPECTION_TYPE = ['INCOMING', 'IN_PROCESS', 'FINAL'] as const;
export type InspectionType = (typeof INSPECTION_TYPE)[number];

/** Source document an inspection is pegged to (drives which fk column is set). */
export const INSPECTION_SOURCE = ['GRN', 'WO'] as const;
export type InspectionSource = (typeof INSPECTION_SOURCE)[number];

/** Gauge status (qms.gauge, new in migration 026). */
export const GAUGE_STATUS = ['ACTIVE', 'DUE', 'OUT_OF_CAL', 'RETIRED'] as const;
export type GaugeStatus = (typeof GAUGE_STATUS)[number];

/** Calibration outcome (qms.calibration_record ck, new in migration 026). */
export const CALIBRATION_RESULT = ['PASS', 'FAIL', 'ADJUSTED'] as const;
export type CalibrationResult = (typeof CALIBRATION_RESULT)[number];

/**
 * RBAC permission codes for this module. The 'INSPECTION' domain does NOT exist
 * in db/08; migration 026 seeds sec.permission + sec.role_permission for it:
 *   QC       = VCEDAX (the quality owner: record results, edit/close, approve
 *                      sign-off, delete, export, register gauges + calibrate),
 *   PRODUCTION/STORES = VC (raise inspections + record incoming/in-process checks),
 *   PURCHASE/ADMIN    = V  (view), CEO = VX (view + export).
 * Inspection create / result recording and calibration create/record are guarded
 * by INSPECTION.CREATE; edits + close by INSPECTION.EDIT; approve / sign-off by
 * INSPECTION.APPROVE; reads by INSPECTION.VIEW; delete + export by their codes.
 */
export const INSPECTION_PERMS = {
  VIEW: 'INSPECTION.VIEW',
  CREATE: 'INSPECTION.CREATE',
  EDIT: 'INSPECTION.EDIT',
  DELETE: 'INSPECTION.DELETE',
  APPROVE: 'INSPECTION.APPROVE',
  EXPORT: 'INSPECTION.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'INSP', pad 6). */
export const DOC_TYPE = 'INSPECTION';

/**
 * Domain event emitted when an inspection's overall result is FAIL. A downstream
 * consumer raises a nonconformance (NCR) from the failed inspection so the 8D
 * quality loop (handled by the separate failure module) is triggered.
 */
export const INSPECTION_FAILED_EVENT = 'inspection.failed';
