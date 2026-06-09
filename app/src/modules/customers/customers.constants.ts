/**
 * Domain constants for the Customer master (M01).
 *
 * mdm.customer is the sell-side party master created in db/01_security_master.sql.
 * A customer is identified by a user-supplied customer_code (globally UNIQUE), carries
 * a type (OEM/EPC/GOVT/DEALER/OTHER), an optional GSTIN/PAN, a credit limit, a required
 * default currency, and a lifecycle status (ACTIVE/HOLD/BLOCKED). The table is
 * company-scoped (company_id), soft-deleted (is_deleted) and optimistically locked
 * (row_version).
 *
 * NOTE: the quotation.won handler auto-creates a customer from a free-text lead name;
 * that flow is separate. This module is the proper manual CRUD over the master.
 */

/** customer_type CHECK domain (db ck_cust_type). */
export const CUSTOMER_TYPES = ['OEM', 'EPC', 'GOVT', 'DEALER', 'OTHER'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** status CHECK domain (db ck_cust_status). */
export const CUSTOMER_STATUSES = ['ACTIVE', 'HOLD', 'BLOCKED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/**
 * RBAC permission codes for the Customer master (the 'CUSTOMER' domain is seeded in
 * db/08_rbac.sql for all six actions). Grants of note: SALES = VCEX (create/edit/view/
 * export), ADMIN = VCEDX (adds delete), CEO/SERVICE/FINANCE = VX, PLANNING/INSTALL = V.
 * reads -> CUSTOMER.VIEW; create -> CUSTOMER.CREATE; update -> CUSTOMER.EDIT;
 * soft-delete -> CUSTOMER.DELETE.
 */
export const CUSTOMER_PERMS = {
  VIEW: 'CUSTOMER.VIEW',
  CREATE: 'CUSTOMER.CREATE',
  EDIT: 'CUSTOMER.EDIT',
  DELETE: 'CUSTOMER.DELETE',
} as const;
