/** Domain constants for the Treasury / Cash-flow module (Tier-3 value-add).
 *
 * A project-based (ETO) manufacturer lives or dies on cash timing: large milestone
 * billings and customer advances on the INFLOW side, vendor bills, payroll and tax
 * on the OUTFLOW side, spread across long project calendars. This module records
 * project-linked cash-flow FORECAST entries (an expected inflow/outflow in a given
 * period) and serves a working-capital POSITION read that combines the forecast with
 * the live AR / AP ledgers (fin.invoice, fin.vendor_invoice, fin.payment_allocation).
 *
 * There is NO base table for it — migration 034 CREATES fin.cashflow_forecast and
 * seeds the new 'TREASURY' RBAC domain (absent from the db/08 catalog).
 */

/**
 * The forecast log is APPEND-ONLY: each entry is a new immutable fin.cashflow_forecast
 * row (no status, no row_version, no soft-delete). A "correction" is simply a newer
 * offsetting row — there is no update and no edit path, exactly like the delivery
 * forecast (migration 017). EDIT/APPROVE are seeded for completeness but not wired to
 * any mutating route.
 */

/** Direction of a forecast cash movement (fin.cashflow_forecast.direction CHECK). */
export const CASHFLOW_DIRECTION = ['INFLOW', 'OUTFLOW'] as const;
export type CashflowDirection = (typeof CASHFLOW_DIRECTION)[number];

/**
 * Category of a forecast cash movement (fin.cashflow_forecast.category CHECK). The
 * source/use of cash, used for grouping and the cash-flow waterfall:
 *   MILESTONE — customer milestone billing (inflow),
 *   ADVANCE   — customer advance / mobilisation (inflow),
 *   VENDOR    — vendor / subcontractor payment (outflow),
 *   PAYROLL   — wages / salaries (outflow),
 *   TAX       — GST / TDS / income tax remittance (outflow),
 *   OVERHEAD  — fixed / running overhead (outflow),
 *   OTHER     — anything else.
 */
export const CASHFLOW_CATEGORY = [
  'MILESTONE', 'ADVANCE', 'VENDOR', 'PAYROLL', 'TAX', 'OVERHEAD', 'OTHER',
] as const;
export type CashflowCategory = (typeof CASHFLOW_CATEGORY)[number];

/**
 * RBAC permission codes for this module (the 'TREASURY' domain is seeded in migration
 * 034 — it is NOT in the db/08 catalog). Grants (flag-letter idiom, db/08):
 *   FINANCE  = VCEDA  (own the forecast: view/create/edit/delete + approve),
 *   CEO      = VAX    (view + approve + export),
 *   ADMIN    = VCEDAX (all six),
 *   PLANNING = V      (read only).
 * create -> TREASURY.CREATE; reads (list / summary / position) -> TREASURY.VIEW;
 * delete -> TREASURY.DELETE; CSV export -> TREASURY.EXPORT. The forecast is
 * append-only, so EDIT / APPROVE / DELETE are not wired to any route.
 */
export const TREASURY_PERMS = {
  VIEW: 'TREASURY.VIEW',
  CREATE: 'TREASURY.CREATE',
  EDIT: 'TREASURY.EDIT',
  DELETE: 'TREASURY.DELETE',
  APPROVE: 'TREASURY.APPROVE',
  EXPORT: 'TREASURY.EXPORT',
} as const;
