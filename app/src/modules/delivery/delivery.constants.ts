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
