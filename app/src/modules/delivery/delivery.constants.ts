/** Domain constants for the Delivery Prediction module (M09). */

/**
 * Delivery Prediction is an APPEND-ONLY forecast log: each "prediction" is a new
 * immutable proj.delivery_forecast row (no status, no row_version, no soft-delete).
 * A "revision" is simply a newer snapshot — the latest forecast wins. There is no
 * update and no delete path.
 */

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   PLANNING/PMO = VCEX  (create + edit + export the forecast),
 *   VIEW held by ADMIN, CEO, FINANCE, PLANNING, PRODUCTION, SALES,
 *   EXPORT held by CEO + PLANNING.
 * The table is append-only, so EDIT/DELETE/APPROVE are not wired to any route.
 */
export const DELIVERY_PERMS = {
  VIEW: 'DELIVERY_FORECAST.VIEW',
  CREATE: 'DELIVERY_FORECAST.CREATE',
  EDIT: 'DELIVERY_FORECAST.EDIT',
  DELETE: 'DELIVERY_FORECAST.DELETE',
  APPROVE: 'DELIVERY_FORECAST.APPROVE',
  EXPORT: 'DELIVERY_FORECAST.EXPORT',
} as const;

/** Risk level of a delivery slip (proj.delivery_forecast.risk_level CHECK). */
export const RISK_LEVEL = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVEL)[number];

/** The dominant cause of the predicted delay (proj.delivery_forecast.driver CHECK). */
export const DRIVER = ['MATERIAL', 'CAPACITY', 'SCHEDULE', 'QUALITY'] as const;
export type Driver = (typeof DRIVER)[number];

/**
 * Domain event emitted when a forecast lands at HIGH risk. Downstream consumers
 * (CEO dashboard / planning alerts) raise an at-risk flag for the project.
 * Payload: { projectId, predictedDelivery, committedDelivery, delayDays, driver }.
 */
export const DELIVERY_AT_RISK_EVENT = 'delivery.at_risk';

/* ------------------------------------------------------------------------- *
 * AUTO delivery-risk derivation (GET /risk/:projectId).
 *
 * The flowchart's Delay Prediction node takes INPUTS = Purchase Delays +
 * Production Delays + Resource/FAT Delays and OUTPUTS Green/Yellow/Red. The
 * manual forecast above is hand-entered; this derives the same RAG light from
 * live upstream signals so it never goes stale. It is READ-ONLY (no table of
 * its own, no migration): it aggregates scm.purchase_order, mfg.work_order and
 * qms.fat_execution, company- and project-scoped.
 * ------------------------------------------------------------------------- */

/** Computed traffic-light output of the AUTO risk endpoint (distinct from the
 *  LOW/MEDIUM/HIGH of the stored forecast — this mirrors the flowchart's RAG). */
export const RISK_RAG = ['GREEN', 'YELLOW', 'RED'] as const;
export type RiskRag = (typeof RISK_RAG)[number];

/**
 * Dominant cause of the derived risk, mapped from the leading signal:
 *   MATERIAL  ← overdue purchase orders (Purchase Delays),
 *   SCHEDULE  ← delayed work orders     (Production Delays),
 *   QUALITY   ← pending/failed FATs      (Resource/FAT Delays).
 * (CAPACITY is part of the stored-forecast driver domain but the AUTO signals
 *  cannot distinguish a late WO due to capacity vs. schedule, so a delayed work
 *  order is always attributed to SCHEDULE.)
 */
export type RiskDriver = 'MATERIAL' | 'CAPACITY' | 'SCHEDULE' | 'QUALITY';

/**
 * PO statuses that have CLOSED OUT a purchase (no longer a delivery risk):
 * RECEIVED (goods in), CLOSED, CANCELLED. Any other status (DRAFT, PENDING,
 * APPROVED, PARTIAL) with a promised date in the past is an overdue PO.
 * (scm.purchase_order.ck_po_status: DRAFT,PENDING,APPROVED,PARTIAL,RECEIVED,CLOSED,CANCELLED.)
 */
export const PO_SETTLED_STATUSES = ['RECEIVED', 'CLOSED', 'CANCELLED'] as const;

/**
 * Work-order statuses that have finished (no longer a production risk):
 * COMPLETED, CLOSED, CANCELLED. A non-finished WO past its planned_end is delayed.
 * (mfg.work_order.ck_wo_status: PLANNED,RELEASED,IN_PROGRESS,COMPLETED,CLOSED,CANCELLED.)
 */
export const WO_FINISHED_STATUSES = ['COMPLETED', 'CLOSED', 'CANCELLED'] as const;

/**
 * FAT lifecycle statuses that count as "pending or failed" (a quality risk to
 * delivery): SCHEDULED + IN_PROGRESS (not yet passed) and FAILED. PASSED/CLEARED
 * have cleared the gate and CANCELLED is dropped, so none of those count.
 * (qms.fat_execution.ck_fat_status: SCHEDULED,IN_PROGRESS,PASSED,FAILED,CLEARED,CANCELLED.)
 */
export const FAT_PENDING_OR_FAILED_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'FAILED'] as const;

/**
 * RED threshold: a project is RED if the combined count of overdue POs and
 * delayed WOs reaches this many (a quality failure forces RED on its own).
 */
export const RISK_RED_DELAY_THRESHOLD = 3;
