import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { INVOICE_CLOSED_STATUSES, TICKET_DOC_TYPE } from './portal.constants';
import {
  PortalLinkage, PortalProject, PortalDispatch, PortalInvoice, PortalInvoiceList,
  PortalTicket, PortalPurchaseOrder, PortalGrn, PortalPayment, RaiseTicketInput,
} from './portal.types';

/**
 * PortalRepository — READ-MOSTLY data access for the Customer / Vendor Portal. It
 * owns no table. Every read runs in a single `runRead` transaction (RLS role +
 * app.company_id GUC) and is ADDITIONALLY filtered by the caller's customer_id /
 * vendor_id so an external portal user can only ever see their own partner's rows
 * (defence in depth on top of company RLS). The two writes — raise-ticket (INSERT
 * svc.service_ticket) and acknowledge-PO (UPDATE scm.purchase_order) — run via
 * runInContext so the DB audit triggers attribute them to the caller.
 *
 * Money/aggregate columns are COALESCEd + cast to float8 so an empty result yields
 * the JS number 0, never NULL.
 */
export class PortalRepository {
  constructor(private readonly pool: Pool) {}

  // ---------------------------------------------------------------------------
  // Linkage — who is this caller? (sec.app_user.customer_id / vendor_id)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the caller's portal linkage: their app_user customer_id / vendor_id
   * plus the linked partner's display name. Read via runRead so it is bounded by
   * the same RLS context as every other query. The explicit user_id predicate
   * means a caller only ever reads their OWN linkage row.
   */
  async fetchLinkage(ctx: RequestContext): Promise<PortalLinkage> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query<{
        customer_id: string | null; vendor_id: string | null;
        customer_name: string | null; vendor_name: string | null;
      }>(
        `SELECT u.customer_id, u.vendor_id, cu.customer_name, ve.vendor_name
           FROM sec.app_user u
           LEFT JOIN mdm.customer cu ON cu.customer_id = u.customer_id
           LEFT JOIN mdm.vendor   ve ON ve.vendor_id   = u.vendor_id
          WHERE u.user_id = $1`,
        [ctx.userId]);
      const r = res.rows[0];
      return {
        customerId: r?.customer_id == null ? null : Number(r.customer_id),
        vendorId: r?.vendor_id == null ? null : Number(r.vendor_id),
        customerName: r?.customer_name ?? null,
        vendorName: r?.vendor_name ?? null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Customer reads (scoped by company_id + customer_id)
  // ---------------------------------------------------------------------------

  async customerProjects(ctx: RequestContext, customerId: number): Promise<PortalProject[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT project_id, project_no, project_name, status
           FROM proj.project
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
          ORDER BY project_id DESC`,
        [ctx.companyId, customerId]);
      return res.rows.map(mapProject);
    });
  }

  async customerDispatches(ctx: RequestContext, customerId: number): Promise<PortalDispatch[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT dispatch_id, dispatch_no, status, dispatch_date
           FROM log.dispatch
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
          ORDER BY dispatch_date DESC, dispatch_id DESC`,
        [ctx.companyId, customerId]);
      return res.rows.map(mapDispatch);
    });
  }

  /** The customer's invoices + their outstanding total (Σ total_amount of the
   *  invoices that are not PAID/CANCELLED). */
  async customerInvoices(ctx: RequestContext, customerId: number): Promise<PortalInvoiceList> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT invoice_id, invoice_no, total_amount, status, invoice_date
           FROM fin.invoice
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
          ORDER BY invoice_date DESC, invoice_id DESC`,
        [ctx.companyId, customerId]);
      const out = await c.query<{ amt: number }>(
        `SELECT COALESCE(SUM(total_amount), 0)::float8 AS amt
           FROM fin.invoice
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
            AND status <> ALL($3::text[])`,
        [ctx.companyId, customerId, [...INVOICE_CLOSED_STATUSES]]);
      return {
        rows: res.rows.map(mapInvoice),
        outstandingTotal: Number(out.rows[0].amt),
      };
    });
  }

  async customerTickets(ctx: RequestContext, customerId: number): Promise<PortalTicket[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ticket_id, ticket_no, priority, status, reported_at, resolution
           FROM svc.service_ticket
          WHERE company_id = $1 AND customer_id = $2 AND NOT is_deleted
          ORDER BY reported_at DESC, ticket_id DESC`,
        [ctx.companyId, customerId]);
      return res.rows.map(mapTicket);
    });
  }

  /**
   * Raise a customer service ticket, allocating its TKT number in the same
   * transaction. company_id = ctx.companyId so the row passes RLS WITH CHECK; the
   * customer_id is the caller's linked customer (never client-supplied).
   */
  async raiseTicket(ctx: RequestContext, input: RaiseTicketInput): Promise<PortalTicket> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO svc.service_ticket
           (company_id, ticket_no, customer_id, priority, resolution, status, created_by)
         VALUES ($1, mdm.next_document_no($1,$2,'${TICKET_DOC_TYPE}'),
                 $3, $4, $5, 'OPEN', $6)
         RETURNING ticket_id, ticket_no, priority, status, reported_at, resolution`,
        [ctx.companyId, ctx.buId, input.customerId, input.priority,
          input.resolution ?? null, ctx.userId]);
      return mapTicket(res.rows[0]);
    });
  }

  // ---------------------------------------------------------------------------
  // Vendor reads (scoped by company_id + vendor_id)
  // ---------------------------------------------------------------------------

  async vendorPurchaseOrders(ctx: RequestContext, vendorId: number): Promise<PortalPurchaseOrder[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT po_id, po_no, status, po_date, total_amount, acknowledged_at
           FROM scm.purchase_order
          WHERE company_id = $1 AND vendor_id = $2 AND NOT is_deleted
          ORDER BY po_date DESC, po_id DESC`,
        [ctx.companyId, vendorId]);
      return res.rows.map(mapPurchaseOrder);
    });
  }

  /** The vendor's goods receipts. grn has its own vendor_id; join the PO for po_no. */
  async vendorGrns(ctx: RequestContext, vendorId: number): Promise<PortalGrn[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT g.grn_id, g.grn_no, g.po_id, p.po_no, g.status, g.grn_date
           FROM scm.goods_receipt g
           LEFT JOIN scm.purchase_order p ON p.po_id = g.po_id
          WHERE g.company_id = $1 AND g.vendor_id = $2 AND NOT g.is_deleted
          ORDER BY g.grn_date DESC, g.grn_id DESC`,
        [ctx.companyId, vendorId]);
      return res.rows.map(mapGrn);
    });
  }

  async vendorPayments(ctx: RequestContext, vendorId: number): Promise<PortalPayment[]> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT vpay_id, vpay_no, amount, pay_date
           FROM fin.vendor_payment
          WHERE company_id = $1 AND vendor_id = $2
          ORDER BY pay_date DESC, vpay_id DESC`,
        [ctx.companyId, vendorId]);
      return res.rows.map(mapPayment);
    });
  }

  /**
   * Acknowledge a PO — stamp acknowledged_at / acknowledged_by, but ONLY for a PO
   * that belongs to the caller's own vendor (the vendor_id predicate makes another
   * vendor's PO invisible -> 0 rows -> the service 404s). Idempotent: re-ack keeps
   * the first acknowledged_at via COALESCE. Returns the refreshed PO, or null when
   * no such PO exists for this vendor.
   */
  async acknowledgePurchaseOrder(
    ctx: RequestContext, poId: number, vendorId: number,
  ): Promise<PortalPurchaseOrder | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE scm.purchase_order
            SET acknowledged_at = COALESCE(acknowledged_at, now()),
                acknowledged_by = COALESCE(acknowledged_by, $1),
                updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE po_id = $2 AND company_id = $3 AND vendor_id = $4 AND NOT is_deleted
        RETURNING po_id, po_no, status, po_date, total_amount, acknowledged_at`,
        [ctx.userId, poId, ctx.companyId, vendorId]);
      if (!res.rowCount) return null;
      return mapPurchaseOrder(res.rows[0]);
    });
  }
}

// --- row mappers (snake_case -> camelCase, defensive numeric coercion) ---

function mapProject(r: QueryResultRow): PortalProject {
  return {
    projectId: Number(r.project_id),
    projectNo: r.project_no,
    projectName: r.project_name,
    status: r.status,
  };
}
function mapDispatch(r: QueryResultRow): PortalDispatch {
  return {
    dispatchId: Number(r.dispatch_id),
    dispatchNo: r.dispatch_no,
    status: r.status,
    dispatchDate: r.dispatch_date ?? null,
  };
}
function mapInvoice(r: QueryResultRow): PortalInvoice {
  return {
    invoiceId: Number(r.invoice_id),
    invoiceNo: r.invoice_no,
    totalAmount: Number(r.total_amount),
    status: r.status,
    invoiceDate: r.invoice_date ?? null,
  };
}
function mapTicket(r: QueryResultRow): PortalTicket {
  return {
    ticketId: Number(r.ticket_id),
    ticketNo: r.ticket_no,
    priority: r.priority,
    status: r.status,
    reportedAt: r.reported_at ?? null,
    resolution: r.resolution ?? null,
  };
}
function mapPurchaseOrder(r: QueryResultRow): PortalPurchaseOrder {
  return {
    poId: Number(r.po_id),
    poNo: r.po_no,
    status: r.status,
    poDate: r.po_date ?? null,
    totalAmount: Number(r.total_amount),
    acknowledgedAt: r.acknowledged_at ?? null,
  };
}
function mapGrn(r: QueryResultRow): PortalGrn {
  return {
    grnId: Number(r.grn_id),
    grnNo: r.grn_no,
    poId: r.po_id == null ? null : Number(r.po_id),
    poNo: r.po_no ?? null,
    status: r.status,
    grnDate: r.grn_date ?? null,
  };
}
function mapPayment(r: QueryResultRow): PortalPayment {
  return {
    vpayId: Number(r.vpay_id),
    vpayNo: r.vpay_no,
    amount: Number(r.amount),
    payDate: r.pay_date ?? null,
  };
}
