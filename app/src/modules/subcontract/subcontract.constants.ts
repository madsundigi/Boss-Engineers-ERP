/** Domain constants for the Subcontracting / Job-Work module (Tier-2 gap). */

/**
 * Subcontract-order lifecycle. The base table scm.subcontract_order (db/03)
 * ships a `status` column whose CHECK is OPEN/MATERIAL_ISSUED/RECEIVED/CLOSED;
 * migration 028 replaces that CHECK with this lifecycle (adds CANCELLED):
 *   OPEN -> ISSUED -> RECEIVED -> CLOSED   (+ CANCELLED from OPEN/ISSUED)
 * The flow models job-work: raw material is ISSUED to a vendor, the processed
 * goods come back (RECEIVED), then the order is CLOSED. RECEIVED emits
 * 'subcontract.received' so downstream (inventory / GL) can take the goods in.
 */
export const SUBCONTRACT_STATUS = [
  'OPEN', 'ISSUED', 'RECEIVED', 'CLOSED', 'CANCELLED',
] as const;
export type SubcontractStatus = (typeof SUBCONTRACT_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<SubcontractStatus, SubcontractStatus[]> = {
  OPEN: ['ISSUED', 'CANCELLED'],
  ISSUED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: ['CLOSED'],
  CLOSED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: SubcontractStatus, to: SubcontractStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module. The 'SUBCONTRACT' domain is NOT in the
 * base sec.permission seed (db/08); migration 028 seeds the six actions and the
 * role grants (PURCHASE=VCEDAX, STORES=VCE, PRODUCTION/FINANCE/ADMIN=V, CEO=VX).
 * Create = SUBCONTRACT.CREATE; issue/receive/edit = SUBCONTRACT.EDIT;
 * approve (close) = SUBCONTRACT.APPROVE; reads = VIEW; delete = DELETE; CSV = EXPORT.
 */
export const SUBCONTRACT_PERMS = {
  VIEW: 'SUBCONTRACT.VIEW',
  CREATE: 'SUBCONTRACT.CREATE',
  EDIT: 'SUBCONTRACT.EDIT',
  DELETE: 'SUBCONTRACT.DELETE',
  APPROVE: 'SUBCONTRACT.APPROVE',
  EXPORT: 'SUBCONTRACT.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'SC', pad 6). */
export const DOC_TYPE = 'SUBCON';

/** The mdm.outbox_event aggregate_type recorded for subcontract events. */
export const SUBCONTRACT_AGGREGATE = 'SUBCONTRACT';

/**
 * Domain event emitted when processed goods are RECEIVED back from the vendor.
 * Downstream consumers (inventory take-in / job-work GL) react to it.
 * Payload: { scNo, vendorId, projectId }.
 */
export const SUBCONTRACT_RECEIVED_EVENT = 'subcontract.received';
