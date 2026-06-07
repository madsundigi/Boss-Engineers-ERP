/** Domain constants for the Project Profitability & Margin Analysis module (M15). */

/**
 * Profitability is an APPEND-ONLY margin-snapshot log: each computeSnapshot is a
 * new immutable fin.margin_snapshot row (no status, no row_version, no soft-delete).
 * Re-computing a project's margin simply inserts a newer snapshot — the latest wins.
 * There is no update and no delete path.
 */

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08):
 *   FINANCE  = VCEAX (create + edit + approve + export, and view),
 *   PLANNING = VA    (view + approve),
 *   VIEW held by ADMIN, CEO, FINANCE, PLANNING,
 *   EXPORT held by CEO + FINANCE.
 * The table is append-only, so EDIT/DELETE are not wired to any route; APPROVE is
 * catalogued (FINANCE + PLANNING hold it) but a snapshot needs no approval step,
 * so it too is unrouted.
 */
export const PROFITABILITY_PERMS = {
  VIEW: 'PROFITABILITY.VIEW',
  CREATE: 'PROFITABILITY.CREATE',
  EDIT: 'PROFITABILITY.EDIT',
  APPROVE: 'PROFITABILITY.APPROVE',
  EXPORT: 'PROFITABILITY.EXPORT',
} as const;

/**
 * Cost-accumulation stage on fin.project_cost_ledger.cost_stage (CHECK, db/05).
 * BUDGET = planned, COMMITTED = obligated (e.g. PO raised), ACTUAL = incurred.
 */
export const COST_STAGE = {
  BUDGET: 'BUDGET',
  COMMITTED: 'COMMITTED',
  ACTUAL: 'ACTUAL',
} as const;
export type CostStage = (typeof COST_STAGE)[keyof typeof COST_STAGE];

/**
 * Domain event emitted whenever a margin snapshot is computed. Downstream
 * consumers (CEO dashboard / finance alerts) refresh the project's margin tile.
 * Payload: { projectId, revenue, actualCost, marginPct }.
 */
export const MARGIN_SNAPSHOT_CREATED_EVENT = 'margin.snapshot.created';
