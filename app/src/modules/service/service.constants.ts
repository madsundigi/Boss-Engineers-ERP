/** Domain constants for the Warranty & Service module (M13). */

/**
 * Service-ticket lifecycle. The base table svc.service_ticket (db/04) ships a
 * `status` column with the states OPEN/ASSIGNED/ON_SITE/RESOLVED/CLOSED;
 * migration 015 replaces that CHECK (ck_ticket_status) with this break-fix
 * lifecycle and moves the default to OPEN:
 *   OPEN -> ASSIGNED -> IN_PROGRESS -> RESOLVED -> CLOSED  (+ CANCELLED)
 *     OPEN        — logged (customer/serial captured, in/out-of-warranty decided)
 *     ASSIGNED    — a field engineer is allocated
 *     IN_PROGRESS — work has started (field visits + spares are being recorded)
 *     RESOLVED    — the fault is fixed (resolution captured); warranty cost booked
 *     CLOSED      — customer-confirmed; terminal
 *     CANCELLED   — abandoned (duplicate / no-fault-found); terminal
 * NB the base constraint allows ON_RESOLVED but NOT 'IN_PROGRESS', so the INSERT
 * default of 'OPEN' is fine but any move to IN_PROGRESS REQUIRES migration 015 to
 * have widened the CHECK first (else a 23514 check violation surfaces as 400).
 */
export const SERVICE_TICKET_STATUS = [
  'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED',
] as const;
export type ServiceTicketStatus = (typeof SERVICE_TICKET_STATUS)[number];

/** Ticket priority (mirrors svc.service_ticket ck_ticket_priority, db/04). */
export const TICKET_PRIORITY = ['LOW', 'MED', 'HIGH', 'CRITICAL'] as const;
export type TicketPriority = (typeof TICKET_PRIORITY)[number];

/** Warranty-claim disposition (mirrors svc.warranty_claim ck_claim_status, db/04). */
export const CLAIM_STATUS = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<ServiceTicketStatus, ServiceTicketStatus[]> = {
  OPEN: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], // re-open to IN_PROGRESS if the fix regresses
  CLOSED: [], // terminal
  CANCELLED: [], // terminal
};

export function canTransition(from: ServiceTicketStatus, to: ServiceTicketStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** A status at/after which field work (visits, spares, assignment) is locked. */
export const TERMINAL_STATUSES: ServiceTicketStatus[] = ['CLOSED', 'CANCELLED'];

/**
 * RBAC permission codes for this module (mirror sec.permission, db/08).
 *   SERVICE  = VCEDAX (full break-fix: log, assign, work, resolve, close, approve),
 *   QC       = V      (view — quality follow-up / failure analysis),
 *   FINANCE  = V      (view — warranty cost visibility).
 * The warranty-claim validity / goodwill (concession) approval is guarded by
 * SERVICE_TICKET.APPROVE — held by SERVICE (and CEO via SERVICE_TICKET 'VX'... CEO
 * holds VX only, so APPROVE is a SERVICE-head action here).
 */
export const SERVICE_PERMS = {
  VIEW: 'SERVICE_TICKET.VIEW',
  CREATE: 'SERVICE_TICKET.CREATE',
  EDIT: 'SERVICE_TICKET.EDIT',
  DELETE: 'SERVICE_TICKET.DELETE',
  APPROVE: 'SERVICE_TICKET.APPROVE',
  EXPORT: 'SERVICE_TICKET.EXPORT',
} as const;

/** Document-numbering type seeded in mdm.numbering_rule (prefix 'TKT', pad 6). */
export const DOC_TYPE = 'SERVICE_TICKET';

/**
 * Domain event emitted when a ticket is RESOLVED. Downstream consumers route the
 * warranty event to Failure Analysis (M14) and push the captured warranty cost
 * (parts + labour + travel) back to the originating project's P&L (M15) — "every
 * warranty event is a data point" (FRD M13).
 */
export const TICKET_RESOLVED_EVENT = 'service_ticket.resolved';

/**
 * Domain event emitted when a warranty claim is APPROVED (validity / goodwill
 * sign-off). Downstream Finance raises the warranty-cost / service-billing entry.
 */
export const WARRANTY_CLAIM_APPROVED_EVENT = 'warranty_claim.approved';
