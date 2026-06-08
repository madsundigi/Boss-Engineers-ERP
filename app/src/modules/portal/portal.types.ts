import { PortalKind, TicketPriority } from './portal.constants';

/**
 * The caller's portal linkage (GET /api/portal/me). kind is 'customer' or 'vendor'
 * when the app_user is linked to one; 'none' when linked to neither. name is the
 * linked partner's display name (customer_name / vendor_name), null for 'none'.
 */
export interface PortalIdentity {
  kind: PortalKind;
  customerId: number | null;
  vendorId: number | null;
  name: string | null;
}

/** A customer's project (projection of proj.project). */
export interface PortalProject {
  projectId: number;
  projectNo: string;
  projectName: string;
  status: string;
}

/** A customer's dispatch (projection of log.dispatch). */
export interface PortalDispatch {
  dispatchId: number;
  dispatchNo: string;
  status: string;
  dispatchDate: string | null;
}

/** A customer's invoice (projection of fin.invoice). */
export interface PortalInvoice {
  invoiceId: number;
  invoiceNo: string;
  totalAmount: number;
  status: string;
  invoiceDate: string | null;
}

/** A customer's invoice list with the open (unsettled) total. */
export interface PortalInvoiceList {
  rows: PortalInvoice[];
  outstandingTotal: number;
}

/** A customer's service ticket (projection of svc.service_ticket). */
export interface PortalTicket {
  ticketId: number;
  ticketNo: string;
  priority: string;
  status: string;
  reportedAt: string | null;
  resolution: string | null;
}

/** A vendor's purchase order (projection of scm.purchase_order). */
export interface PortalPurchaseOrder {
  poId: number;
  poNo: string;
  status: string;
  poDate: string | null;
  totalAmount: number;
  acknowledgedAt: string | null;
}

/** A vendor's goods receipt (projection of scm.goods_receipt). */
export interface PortalGrn {
  grnId: number;
  grnNo: string;
  poId: number | null;
  poNo: string | null;
  status: string;
  grnDate: string | null;
}

/** A vendor's payment (projection of fin.vendor_payment). */
export interface PortalPayment {
  vpayId: number;
  vpayNo: string;
  amount: number;
  payDate: string | null;
}

/** The caller's resolved linkage row (sec.app_user.customer_id / vendor_id +
 *  the partner's display name), used internally to scope every portal query. */
export interface PortalLinkage {
  customerId: number | null;
  vendorId: number | null;
  customerName: string | null;
  vendorName: string | null;
}

/** Fields the service hands the repository to raise a customer ticket. */
export interface RaiseTicketInput {
  customerId: number;
  priority: TicketPriority;
  resolution?: string;
}
