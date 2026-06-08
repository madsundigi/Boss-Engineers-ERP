import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { PortalRepository } from './portal.repository';
import { RaiseTicketDto } from './portal.dto';
import {
  PortalIdentity, PortalProject, PortalDispatch, PortalInvoiceList, PortalTicket,
  PortalPurchaseOrder, PortalGrn, PortalPayment, PortalLinkage,
} from './portal.types';

/**
 * Repository surface the service depends on (lets the unit test inject a fake with
 * no database). Lists exactly the methods PortalService calls.
 */
export type PortalRepoLike = Pick<
  PortalRepository,
  | 'fetchLinkage'
  | 'customerProjects' | 'customerDispatches' | 'customerInvoices'
  | 'customerTickets' | 'raiseTicket'
  | 'vendorPurchaseOrders' | 'vendorGrns' | 'vendorPayments'
  | 'acknowledgePurchaseOrder'
>;

/**
 * PortalService — business logic for the Customer / Vendor Portal. Stateless;
 * depends only on the repository (injected) so it is unit-testable without a DB.
 *
 * THE ACCESS MODEL lives here: it resolves the caller's linkage
 * (sec.app_user.customer_id / vendor_id) and gates every endpoint to it.
 *   - a customer-linked caller may use the customer endpoints; the vendor ones 403
 *     ('not a vendor portal user') and vice versa,
 *   - a caller linked to NEITHER gets 403 ('not a portal user') on any data
 *     endpoint (but GET /me still answers, returning kind 'none').
 * Reads are auto-scoped to the resolved customerId / vendorId so an external user
 * only ever sees their own data; the two writes likewise act only on the caller's
 * own customer (raise-ticket) / vendor's PO (acknowledge).
 */
export class PortalService {
  constructor(private readonly repo: PortalRepoLike) {}

  /** GET /api/portal/me — report the caller's linkage (or kind 'none'). */
  async getIdentity(ctx: RequestContext): Promise<PortalIdentity> {
    const link = await this.repo.fetchLinkage(ctx);
    if (link.customerId != null) {
      return { kind: 'customer', customerId: link.customerId, vendorId: null, name: link.customerName };
    }
    if (link.vendorId != null) {
      return { kind: 'vendor', customerId: null, vendorId: link.vendorId, name: link.vendorName };
    }
    return { kind: 'none', customerId: null, vendorId: null, name: null };
  }

  // --- access guards -------------------------------------------------------

  /** Resolve the caller's customer linkage or 403. */
  private async requireCustomer(ctx: RequestContext): Promise<number> {
    const link = await this.repo.fetchLinkage(ctx);
    return this.customerIdOrThrow(link);
  }

  /** Resolve the caller's vendor linkage or 403. */
  private async requireVendor(ctx: RequestContext): Promise<number> {
    const link = await this.repo.fetchLinkage(ctx);
    return this.vendorIdOrThrow(link);
  }

  private customerIdOrThrow(link: PortalLinkage): number {
    if (link.customerId != null) return link.customerId;
    if (link.vendorId != null) throw Errors.forbidden('not a customer portal user');
    throw Errors.forbidden('not a portal user');
  }

  private vendorIdOrThrow(link: PortalLinkage): number {
    if (link.vendorId != null) return link.vendorId;
    if (link.customerId != null) throw Errors.forbidden('not a vendor portal user');
    throw Errors.forbidden('not a portal user');
  }

  // --- customer endpoints --------------------------------------------------

  async getProjects(ctx: RequestContext): Promise<PortalProject[]> {
    return this.repo.customerProjects(ctx, await this.requireCustomer(ctx));
  }

  async getDispatches(ctx: RequestContext): Promise<PortalDispatch[]> {
    return this.repo.customerDispatches(ctx, await this.requireCustomer(ctx));
  }

  async getInvoices(ctx: RequestContext): Promise<PortalInvoiceList> {
    return this.repo.customerInvoices(ctx, await this.requireCustomer(ctx));
  }

  async getTickets(ctx: RequestContext): Promise<PortalTicket[]> {
    return this.repo.customerTickets(ctx, await this.requireCustomer(ctx));
  }

  /**
   * Raise a service ticket for the caller's linked customer. Requires a branch
   * (x-bu-id) to allocate the TKT number — 400 otherwise, mirroring the other
   * numbered-document creates. The customer_id is the caller's own, never the body.
   */
  async raiseTicket(ctx: RequestContext, dto: RaiseTicketDto): Promise<PortalTicket> {
    const customerId = await this.requireCustomer(ctx);
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to raise a ticket');
    }
    return this.repo.raiseTicket(ctx, {
      customerId,
      priority: dto.priority ?? 'MED',
      resolution: dto.subject,
    });
  }

  // --- vendor endpoints ----------------------------------------------------

  async getPurchaseOrders(ctx: RequestContext): Promise<PortalPurchaseOrder[]> {
    return this.repo.vendorPurchaseOrders(ctx, await this.requireVendor(ctx));
  }

  async getGrns(ctx: RequestContext): Promise<PortalGrn[]> {
    return this.repo.vendorGrns(ctx, await this.requireVendor(ctx));
  }

  async getPayments(ctx: RequestContext): Promise<PortalPayment[]> {
    return this.repo.vendorPayments(ctx, await this.requireVendor(ctx));
  }

  /**
   * Acknowledge one of the caller's vendor's POs. The repository scopes the UPDATE
   * to (po_id, company, vendor_id) so another vendor's PO is invisible and yields
   * null -> 404. Returns the refreshed PO on success.
   */
  async acknowledgePurchaseOrder(ctx: RequestContext, poId: number): Promise<PortalPurchaseOrder> {
    const vendorId = await this.requireVendor(ctx);
    const updated = await this.repo.acknowledgePurchaseOrder(ctx, poId, vendorId);
    if (!updated) throw Errors.notFound(`Purchase order ${poId} not found`);
    return updated;
  }
}
