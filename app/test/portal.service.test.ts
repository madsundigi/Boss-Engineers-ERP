import { PortalService, PortalRepoLike } from '../src/modules/portal/portal.service';
import { RequestContext } from '../src/common/request-context';
import { AppError } from '../src/common/http-error';
import {
  PortalLinkage, PortalTicket, PortalPurchaseOrder,
} from '../src/modules/portal/portal.types';

const ctx: RequestContext = {
  userId: 5, username: 'portal', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

/** A linkage row; by default the caller is linked to neither partner. */
function linkage(over: Partial<PortalLinkage> = {}): PortalLinkage {
  return { customerId: null, vendorId: null, customerName: null, vendorName: null, ...over };
}
const asCustomer = linkage({ customerId: 50, customerName: 'Test Customer Ltd' });
const asVendor = linkage({ vendorId: 80, vendorName: 'Test Vendor Pvt Ltd' });

function ticket(over: Partial<PortalTicket> = {}): PortalTicket {
  return {
    ticketId: 9, ticketNo: 'TKT/MUM/2026-27/000009', priority: 'MED',
    status: 'OPEN', reportedAt: 't', resolution: 'pump leaking', ...over,
  };
}
function po(over: Partial<PortalPurchaseOrder> = {}): PortalPurchaseOrder {
  return {
    poId: 200, poNo: 'PO/MUM/2026-27/000200', status: 'APPROVED',
    poDate: '2026-06-01', totalAmount: 12000, acknowledgedAt: null, ...over,
  };
}

/** Fake repo (no DB): every method is a jest.fn; fetchLinkage drives the access model. */
function makeRepo() {
  return {
    fetchLinkage: jest.fn(),
    customerProjects: jest.fn(),
    customerDispatches: jest.fn(),
    customerInvoices: jest.fn(),
    customerTickets: jest.fn(),
    raiseTicket: jest.fn(),
    vendorPurchaseOrders: jest.fn(),
    vendorGrns: jest.fn(),
    vendorPayments: jest.fn(),
    acknowledgePurchaseOrder: jest.fn(),
  } as unknown as jest.Mocked<PortalRepoLike>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('PortalService', () => {
  let repo: jest.Mocked<PortalRepoLike>;
  let service: PortalService;
  beforeEach(() => { repo = makeRepo(); service = new PortalService(repo); });

  describe('GET /me — linkage mapping', () => {
    it('maps a customer-linked caller to kind customer', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      const me = await service.getIdentity(ctx);
      expect(me).toEqual({ kind: 'customer', customerId: 50, vendorId: null, name: 'Test Customer Ltd' });
    });

    it('maps a vendor-linked caller to kind vendor', async () => {
      repo.fetchLinkage.mockResolvedValue(asVendor);
      const me = await service.getIdentity(ctx);
      expect(me).toEqual({ kind: 'vendor', customerId: null, vendorId: 80, name: 'Test Vendor Pvt Ltd' });
    });

    it('maps an unlinked caller to kind none (no 403 on /me)', async () => {
      repo.fetchLinkage.mockResolvedValue(linkage());
      const me = await service.getIdentity(ctx);
      expect(me).toEqual({ kind: 'none', customerId: null, vendorId: null, name: null });
    });
  });

  describe('access model — customer vs vendor gating', () => {
    it('403 when a customer-linked caller hits a VENDOR endpoint', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      await expect(code(service.getPurchaseOrders(ctx))).resolves.toBe(403);
      expect(repo.vendorPurchaseOrders).not.toHaveBeenCalled();
    });

    it('403 (not a vendor portal user message) for a customer hitting acknowledge', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      const err = await service.acknowledgePurchaseOrder(ctx, 200).catch((e: AppError) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).message).toMatch(/not a vendor portal user/);
    });

    it('403 when a vendor-linked caller hits a CUSTOMER endpoint', async () => {
      repo.fetchLinkage.mockResolvedValue(asVendor);
      await expect(code(service.getProjects(ctx))).resolves.toBe(403);
      expect(repo.customerProjects).not.toHaveBeenCalled();
    });

    it('403 (not a portal user) when an UNLINKED caller hits any data endpoint', async () => {
      repo.fetchLinkage.mockResolvedValue(linkage());
      const err = await service.getProjects(ctx).catch((e: AppError) => e);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).message).toMatch(/not a portal user/);
      // vendor side too
      await expect(code(service.getPayments(ctx))).resolves.toBe(403);
    });
  });

  describe('customer reads auto-scope to the linked customer_id', () => {
    it('passes the caller customer_id to the repository', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      repo.customerProjects.mockResolvedValue([]);
      await service.getProjects(ctx);
      expect(repo.customerProjects).toHaveBeenCalledWith(ctx, 50);
    });
  });

  describe('raiseTicket — builds the right payload from the caller linkage', () => {
    it('uses the caller customer_id + defaults priority to MED', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      repo.raiseTicket.mockResolvedValue(ticket());
      const out = await service.raiseTicket(ctx, { subject: 'pump leaking' });
      expect(out.ticketNo).toMatch(/^TKT\//);
      expect(repo.raiseTicket).toHaveBeenCalledWith(ctx, {
        customerId: 50, priority: 'MED', resolution: 'pump leaking',
      });
    });

    it('honours an explicit priority', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      repo.raiseTicket.mockResolvedValue(ticket({ priority: 'HIGH' }));
      await service.raiseTicket(ctx, { priority: 'HIGH', subject: 'down' });
      const [, input] = repo.raiseTicket.mock.calls[0];
      expect(input).toMatchObject({ customerId: 50, priority: 'HIGH', resolution: 'down' });
    });

    it('400 when no branch context to allocate a ticket number', async () => {
      repo.fetchLinkage.mockResolvedValue(asCustomer);
      await expect(code(service.raiseTicket({ ...ctx, buId: null }, { subject: 'x' })))
        .resolves.toBe(400);
      expect(repo.raiseTicket).not.toHaveBeenCalled();
    });

    it('403 when a vendor-linked caller tries to raise a ticket', async () => {
      repo.fetchLinkage.mockResolvedValue(asVendor);
      await expect(code(service.raiseTicket(ctx, { subject: 'x' }))).resolves.toBe(403);
      expect(repo.raiseTicket).not.toHaveBeenCalled();
    });
  });

  describe('acknowledgePurchaseOrder — vendor-scoped', () => {
    it('returns the refreshed PO on success', async () => {
      repo.fetchLinkage.mockResolvedValue(asVendor);
      repo.acknowledgePurchaseOrder.mockResolvedValue(po({ acknowledgedAt: 't' }));
      const out = await service.acknowledgePurchaseOrder(ctx, 200);
      expect(out.acknowledgedAt).toBe('t');
      expect(repo.acknowledgePurchaseOrder).toHaveBeenCalledWith(ctx, 200, 80);
    });

    it('404 when the PO is not the caller vendor own (repo returns null)', async () => {
      repo.fetchLinkage.mockResolvedValue(asVendor);
      repo.acknowledgePurchaseOrder.mockResolvedValue(null);
      await expect(code(service.acknowledgePurchaseOrder(ctx, 999))).resolves.toBe(404);
    });
  });
});
