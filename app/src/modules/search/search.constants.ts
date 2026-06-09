/** Domain constants for the Central Search module (global cross-entity search). */

/**
 * Central Search is a READ-ONLY cross-module surface: it owns NO base table,
 * performs NO writes, and emits NO outbox events. Every query SELECTs (with a
 * small LIMIT) from existing module tables, company-scoped via the app.company_id
 * RLS GUC set by runRead plus an explicit `company_id = $1` filter where the
 * column exists.
 *
 * RBAC — two layers:
 *   1. The single GET route is gated on the baseline 'DASHBOARD.VIEW' permission,
 *      which essentially every operational role holds (CEO, ADMIN, SALES, PURCHASE,
 *      STORES, PRODUCTION, PLANNING, QC, INSTALL, SERVICE, FINANCE, HR). This makes
 *      the search box itself available to anyone who can see a dashboard.
 *   2. Each entity GROUP is ADDITIONALLY filtered in the service by the caller's
 *      per-module VIEW permission (deny-by-default): a user only gets enquiry hits
 *      if they hold ENQUIRY.VIEW, quotation hits if QUOTATION.VIEW, etc. A group the
 *      caller may not see is never queried and never appears in the response.
 * There is deliberately no CREATE/EDIT/DELETE/APPROVE — this module is read-only.
 */

/** Default per-group hit cap when the caller does not specify `limit`. */
export const SEARCH_DEFAULT_LIMIT = 8;

/** Hard upper bound on the per-group hit cap (also enforced by the DTO). */
export const SEARCH_MAX_LIMIT = 25;
