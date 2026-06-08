/** Domain constants for the Customer / Vendor Portal module (FRD §11, Tier-3).
 *
 * The portal is a self-service, READ-MOSTLY surface for EXTERNAL users. A portal
 * user is an sec.app_user that has been LINKED to exactly one trading partner via
 * the nullable sec.app_user.customer_id / vendor_id columns (added in migration
 * 040). Every endpoint AUTO-SCOPES to that linkage — a customer-linked caller sees
 * only their own projects / dispatches / invoices / tickets (and may raise a
 * ticket); a vendor-linked caller sees only their own POs / GRNs / payments (and
 * may acknowledge a PO). A caller linked to neither is not a portal user (403).
 *
 * The module owns NO base table: it READS existing company-scoped tables
 * (proj.project, log.dispatch, fin.invoice, svc.service_ticket, scm.purchase_order,
 * scm.goods_receipt, fin.vendor_payment) through the RLS-enforced erp_app role,
 * additionally filtered by the caller's customer_id / vendor_id so an external user
 * can never see another partner's rows. Its only writes are raise-ticket (INSERT
 * svc.service_ticket) and acknowledge-PO (UPDATE scm.purchase_order).
 */

/**
 * RBAC permission codes for this module. The 'PORTAL' domain is NOT in the db/08
 * catalog — it is seeded in migration 040 with the six standard actions. Grants:
 *   ADMIN   = VCEDAX (all six),
 *   SALES   = VC     (view + create — owns the customer relationship),
 *   SERVICE = VC     (view + create — fields the tickets customers raise),
 *   PURCHASE= VC     (view + create — owns the vendor relationship),
 *   CEO     = V      (view only).
 * Reads (every GET) -> PORTAL.VIEW; raise-ticket + acknowledge-PO -> PORTAL.CREATE.
 * A real external customer/vendor user is an app_user linked via the new columns
 * and assigned a role that carries the PORTAL perms.
 */
export const PORTAL_PERMS = {
  VIEW: 'PORTAL.VIEW',
  CREATE: 'PORTAL.CREATE',
  EDIT: 'PORTAL.EDIT',
  DELETE: 'PORTAL.DELETE',
  APPROVE: 'PORTAL.APPROVE',
  EXPORT: 'PORTAL.EXPORT',
} as const;

/**
 * The caller's portal linkage kind, derived from sec.app_user.customer_id /
 * vendor_id. 'none' means the caller is not a portal user (linked to neither).
 */
export const PORTAL_KIND = ['customer', 'vendor', 'none'] as const;
export type PortalKind = (typeof PORTAL_KIND)[number];

/**
 * Invoice statuses that close out a receivable (fin.invoice CHECK: DRAFT, POSTED,
 * SENT, PARTIALLY_PAID, PAID, CANCELLED). A PAID or CANCELLED invoice contributes
 * nothing to the customer's outstanding balance shown on the portal.
 */
export const INVOICE_CLOSED_STATUSES = ['PAID', 'CANCELLED'] as const;

/**
 * Document-numbering type for a service ticket (prefix 'TKT'). The rule is ALREADY
 * seeded in db/07 and the SERVICE_TICKET RBAC domain in db/08, so migration 040
 * seeds NEITHER — the portal allocates a ticket number via
 * mdm.next_document_no(company, bu, 'SERVICE_TICKET') when a customer raises one.
 */
export const TICKET_DOC_TYPE = 'SERVICE_TICKET';

/** Ticket priorities a portal customer may pick when raising a ticket
 *  (svc.service_ticket CHECK: LOW, MED, HIGH, CRITICAL). Defaults to MED. */
export const TICKET_PRIORITY = ['LOW', 'MED', 'HIGH', 'CRITICAL'] as const;
export type TicketPriority = (typeof TICKET_PRIORITY)[number];
