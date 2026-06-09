/** Domain constants for the CEO / Management Dashboard module (M16). */

/**
 * M16 is a READ-ONLY cross-module KPI aggregation surface: it owns NO base table,
 * performs NO writes, and emits NO outbox events. Every endpoint SELECTs (aggregates)
 * existing module tables, company-scoped via the app.company_id RLS GUC set by
 * runRead plus an explicit `company_id = $1` filter where the column exists.
 *
 * RBAC permission codes (mirror sec.permission, db/08 — perm_code = MODULE.ACTION):
 *   DASHBOARD.VIEW   — held by essentially every role (CEO, ADMIN, FINANCE, HR,
 *                      INSTALL, PLANNING, PRODUCTION, PURCHASE, QC, SALES, SERVICE,
 *                      STORES); guards all read endpoints.
 *   DASHBOARD.EXPORT — held by CEO + FINANCE only; guards the CSV export.
 * There is deliberately no CREATE/EDIT/DELETE/APPROVE — this module is read-only.
 */
export const DASHBOARD_PERMS = {
  VIEW: 'DASHBOARD.VIEW',
  EXPORT: 'DASHBOARD.EXPORT',
} as const;

/**
 * Terminal statuses excluded from "work in progress" work-order counts
 * (mfg.work_order CHECK: PLANNED, RELEASED, IN_PROGRESS, COMPLETED, CLOSED, CANCELLED).
 */
export const WO_TERMINAL_STATUSES = ['COMPLETED', 'CLOSED', 'CANCELLED'] as const;

/**
 * Invoice statuses that close out a receivable (fin.invoice CHECK includes
 * DRAFT, POSTED, SENT, PARTIALLY_PAID, PAID, CANCELLED). An invoice that is PAID
 * or CANCELLED contributes nothing to AR outstanding.
 */
export const INVOICE_CLOSED_STATUSES = ['PAID', 'CANCELLED'] as const;

/**
 * Vendor-invoice statuses excluded from AP outstanding (fin.vendor_invoice CHECK:
 * PENDING, MATCHED, APPROVED, PAID, DISPUTED). PAID is settled; DISPUTED is parked.
 */
export const VENDOR_INVOICE_EXCLUDED_STATUSES = ['PAID', 'DISPUTED'] as const;

/**
 * Invoice statuses excluded from invoiced revenue: an invoice only counts toward
 * revenue once it has been issued, so DRAFT (not issued) and CANCELLED (voided) are
 * dropped; POSTED/SENT/PARTIALLY_PAID/PAID all count (fin.invoice ck_invoice_status).
 */
export const REVENUE_EXCLUDED_INVOICE_STATUSES = ['DRAFT', 'CANCELLED'] as const;

/**
 * Service-ticket statuses that have closed out a ticket (no longer "open"):
 * RESOLVED + CLOSED. Any other status (OPEN, ASSIGNED, ON_SITE) is still open work
 * (svc.service_ticket ck_ticket_status: OPEN, ASSIGNED, ON_SITE, RESOLVED, CLOSED).
 */
export const SERVICE_TICKET_CLOSED_STATUSES = ['RESOLVED', 'CLOSED'] as const;
