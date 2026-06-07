/** Domain constants for the Contract Management module (commercial customer contract).
 *
 * This is the COMMERCIAL customer contract (sales.customer_contract) — the binding
 * agreement that fixes contract value, payment terms, LD/penalty + warranty
 * obligations, and the billing milestone schedule for a project. NOTE: AMC /
 * service contracts are a different document and live in the Service module
 * (svc.service_contract); this module never touches those.
 */

/**
 * Contract lifecycle (sales.customer_contract.status):
 *   DRAFT -> ACTIVE -> CLOSED (+ CANCELLED)
 * DRAFT is fully editable (header + milestones). ACTIVATE freezes the commercials
 * and emits 'contract.activated' (downstream billing / project consumers). CLOSED
 * is reached at the end of the obligation period; CANCELLED abandons a contract.
 * CLOSED and CANCELLED are terminal.
 */
export const CONTRACT_STATUS = [
  'DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['CLOSED', 'CANCELLED'],
  CLOSED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: ContractStatus, to: ContractStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Billing-milestone lifecycle (sales.contract_milestone.status):
 *   PENDING -> INVOICED -> PAID
 * A milestone is raised PENDING; markMilestoneInvoiced moves it to INVOICED once an
 * invoice is raised against it; markMilestonePaid to PAID once settled.
 */
export const MILESTONE_STATUS = ['PENDING', 'INVOICED', 'PAID'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

export const MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
  PENDING: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: [], // terminal
};

export function canTransitionMilestone(from: MilestoneStatus, to: MilestoneStatus): boolean {
  return MILESTONE_TRANSITIONS[from].includes(to);
}

/**
 * RBAC permission codes for this module (the 'CONTRACT' domain is seeded in
 * migration 029 — it is NOT in the db/08 catalog). Grants:
 *   SALES   = VCE  (own the document: view/create/edit, no approve),
 *   FINANCE = VCEA (view/create/edit + activate/approve),
 *   CEO     = VAX  (view + activate + export),
 *   ADMIN   = VCEDAX (all six),
 *   PLANNING/PRODUCTION = V (read only).
 * create -> CONTRACT.CREATE; update / milestone-edit -> CONTRACT.EDIT;
 * activate / approve -> CONTRACT.APPROVE; reads -> CONTRACT.VIEW;
 * soft-delete -> CONTRACT.DELETE; CSV export -> CONTRACT.EXPORT.
 */
export const CONTRACT_PERMS = {
  VIEW: 'CONTRACT.VIEW',
  CREATE: 'CONTRACT.CREATE',
  EDIT: 'CONTRACT.EDIT',
  DELETE: 'CONTRACT.DELETE',
  APPROVE: 'CONTRACT.APPROVE',
  EXPORT: 'CONTRACT.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'CON'). */
export const DOC_TYPE = 'CONTRACT';

/**
 * Domain event emitted when a contract is ACTIVATED (atomically with the status
 * change via the transactional outbox). Payload:
 *   { contractNo, customerId, projectId, contractValue }.
 * Downstream consumers (billing / project / dashboards) react to the binding
 * commercial agreement coming into force.
 */
export const CONTRACT_ACTIVATED_EVENT = 'contract.activated';
