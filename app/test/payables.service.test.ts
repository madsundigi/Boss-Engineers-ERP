import { PayablesService, sumLineAmounts } from '../src/modules/payables/payables.service';
import { PayablesRepository, VendorInvoiceLineInput, VendorPaymentInput } from '../src/modules/payables/payables.repository';
import { RequestContext } from '../src/common/request-context';
import { OutboxEventInput } from '../src/outbox/outbox';
import { VendorInvoice, VendorPayment } from '../src/modules/payables/payables.types';
import { VENDOR_INVOICE_APPROVED_EVENT } from '../src/modules/payables/payables.constants';
import { AppError } from '../src/common/http-error';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: 5, username: 'finance', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(), ...over,
});

function invoice(over: Partial<VendorInvoice> = {}): VendorInvoice {
  return {
    vendorInvoiceId: 7, companyId: 1, buId: 1, vinvNo: 'SUPP-1001', vendorId: 4,
    poId: null, grnId: null, invoiceDate: '2026-06-01', totalAmount: 1000, status: 'PENDING',
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    lines: [{ vinvLineId: 1, itemId: 9, qty: 10, unitRate: 100, amount: 1000 }],
    ...over,
  };
}

function payment(over: Partial<VendorPayment> = {}): VendorPayment {
  return {
    vpayId: 1, companyId: 1, buId: 1, vpayNo: 'VPY/MUM/2026-27/000001', vendorId: 4,
    vendorInvoiceId: 7, payDate: '2026-06-05', amount: 1000, ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
    poTotal: jest.fn(),
    paidTotal: jest.fn(),
    createPayment: jest.fn(),
    listPayments: jest.fn(),
  } as unknown as jest.Mocked<PayablesRepository>;
}

/** Resolve a service call to its HTTP status code (0 on success). */
const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('PayablesService', () => {
  let repo: jest.Mocked<PayablesRepository>;
  let service: PayablesService;
  beforeEach(() => { repo = makeRepo(); service = new PayablesService(repo); });

  describe('sumLineAmounts / create', () => {
    it('total_amount is the Σ of the line amounts (and survives float accumulation)', () => {
      expect(sumLineAmounts([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
      expect(sumLineAmounts([{ amount: 1000 }, { amount: 250.5 }])).toBe(1250.5);
    });

    it('create passes the computed total + PENDING lines to the repo', async () => {
      const created = invoice();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx(), {
        vinvNo: 'SUPP-1001', vendorId: 4,
        lines: [{ amount: 600 }, { amount: 400 }],
      });
      expect(out).toBe(created);
      const [, header, lines, total] = repo.create.mock.calls[0] as
        [RequestContext, unknown, VendorInvoiceLineInput[], number];
      expect(total).toBe(1000);
      expect(lines).toHaveLength(2);
      expect(header).toMatchObject({ vinvNo: 'SUPP-1001', vendorId: 4 });
    });
  });

  describe('getById', () => {
    it('404s an unknown invoice', async () => {
      repo.findById.mockResolvedValue(null);
      expect(await code(service.getById(ctx(), 999))).toBe(404);
    });
  });

  describe('match (3-way match, PENDING -> MATCHED)', () => {
    it('matches a PENDING invoice with no PO unconditionally', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING', poId: null }));
      repo.updateStatus.mockResolvedValue(invoice({ status: 'MATCHED' }));
      expect(await code(service.match(ctx(), 7, 1))).toBe(0);
      expect(repo.updateStatus).toHaveBeenCalledWith(ctx(), 7, 1, 'MATCHED');
    });

    it('409 when matching from a non-PENDING state', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'APPROVED' }));
      expect(await code(service.match(ctx(), 7, 1))).toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('409 when a linked PO total disagrees with the invoice total', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING', poId: 8, totalAmount: 1000 }));
      repo.poTotal.mockResolvedValue(900); // mismatch
      expect(await code(service.match(ctx(), 7, 1))).toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('matches when the linked PO total agrees', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING', poId: 8, totalAmount: 1000 }));
      repo.poTotal.mockResolvedValue(1000);
      repo.updateStatus.mockResolvedValue(invoice({ status: 'MATCHED' }));
      expect(await code(service.match(ctx(), 7, 1))).toBe(0);
    });

    it('409 (row version mismatch) when the repo reports no row updated', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING', poId: null }));
      repo.updateStatus.mockResolvedValue(null);
      expect(await code(service.match(ctx(), 7, 2))).toBe(409);
    });
  });

  describe('approve (MATCHED -> APPROVED, emits event)', () => {
    it('approves only from MATCHED and emits vendor_invoice.approved', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'MATCHED', vinvNo: 'SUPP-1001', vendorId: 4, totalAmount: 1000 }));
      repo.updateStatus.mockResolvedValue(invoice({ status: 'APPROVED' }));
      expect(await code(service.approve(ctx(), 7, 1))).toBe(0);
      const [, , , , event] = repo.updateStatus.mock.calls[0] as
        [RequestContext, number, number, string, OutboxEventInput];
      expect(event.eventType).toBe(VENDOR_INVOICE_APPROVED_EVENT);
      expect(event.payload).toMatchObject({ vinvNo: 'SUPP-1001', vendorId: 4, totalAmount: 1000 });
    });

    it('409 when approving a still-PENDING invoice (must be MATCHED first)', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING' }));
      expect(await code(service.approve(ctx(), 7, 1))).toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('409 (row version mismatch) when the repo reports no row updated', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'MATCHED' }));
      repo.updateStatus.mockResolvedValue(null);
      expect(await code(service.approve(ctx(), 7, 9))).toBe(409);
    });
  });

  describe('dispute (* non-PAID -> DISPUTED)', () => {
    it('disputes a MATCHED invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'MATCHED' }));
      repo.updateStatus.mockResolvedValue(invoice({ status: 'DISPUTED' }));
      expect(await code(service.dispute(ctx(), 7, { reason: 'price mismatch', rowVersion: 1 }))).toBe(0);
    });
    it('409 when disputing a PAID invoice (terminal)', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PAID' }));
      expect(await code(service.dispute(ctx(), 7, { reason: 'x', rowVersion: 1 }))).toBe(409);
    });
  });

  describe('update (PENDING only)', () => {
    it('409 when editing a non-PENDING invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'MATCHED' }));
      expect(await code(service.update(ctx(), 7, { vinvNo: 'X', rowVersion: 1 }))).toBe(409);
      expect(repo.update).not.toHaveBeenCalled();
    });
    it('recomputes total_amount from replaced lines', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING' }));
      repo.update.mockResolvedValue(invoice({ totalAmount: 1500 }));
      await service.update(ctx(), 7, { lines: [{ amount: 1000 }, { amount: 500 }], rowVersion: 1 });
      const [, , , , mappedLines, total] = repo.update.mock.calls[0] as
        [RequestContext, number, number, unknown, VendorInvoiceLineInput[], number];
      expect(total).toBe(1500);
      expect(mappedLines).toHaveLength(2);
    });
    it('409 (row version mismatch) maps to conflict', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PENDING' }));
      repo.update.mockResolvedValue(null);
      expect(await code(service.update(ctx(), 7, { vinvNo: 'X', rowVersion: 1 }))).toBe(409);
    });
  });

  describe('delete (PENDING only)', () => {
    it('409 when deleting a non-PENDING invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'APPROVED' }));
      expect(await code(service.delete(ctx(), 7))).toBe(409);
      expect(repo.softDelete).not.toHaveBeenCalled();
    });
  });

  describe('createPayment', () => {
    it('400 without a branch (x-bu-id) — required for VPAY numbering', async () => {
      expect(await code(service.createPayment(ctx({ buId: null }), { vendorInvoiceId: 7, amount: 100 }))).toBe(400);
      expect(repo.createPayment).not.toHaveBeenCalled();
    });

    it('409 when paying a non-APPROVED invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'MATCHED' }));
      expect(await code(service.createPayment(ctx(), { vendorInvoiceId: 7, amount: 100 }))).toBe(409);
      expect(repo.createPayment).not.toHaveBeenCalled();
    });

    it('400 when the payment would exceed the outstanding balance', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'APPROVED', totalAmount: 1000 }));
      repo.paidTotal.mockResolvedValue(800);
      expect(await code(service.createPayment(ctx(), { vendorInvoiceId: 7, amount: 300 }))).toBe(400); // 800+300 > 1000
      expect(repo.createPayment).not.toHaveBeenCalled();
    });

    it('records a partial payment WITHOUT flipping the invoice to PAID', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'APPROVED', totalAmount: 1000 }));
      repo.paidTotal.mockResolvedValue(0);
      repo.createPayment.mockResolvedValue(payment({ amount: 400 }));
      await service.createPayment(ctx(), { vendorInvoiceId: 7, amount: 400 });
      const [, input, markPaid] = repo.createPayment.mock.calls[0] as [RequestContext, VendorPaymentInput, boolean];
      expect(markPaid).toBe(false);
      expect(input).toMatchObject({ vendorInvoiceId: 7, vendorId: 4, amount: 400 });
    });

    it('drives the invoice to PAID once Σ payments reaches the total', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'APPROVED', totalAmount: 1000 }));
      repo.paidTotal.mockResolvedValue(600); // 600 + 400 == 1000
      repo.createPayment.mockResolvedValue(payment({ amount: 400 }));
      await service.createPayment(ctx(), { vendorInvoiceId: 7, amount: 400 });
      const [, , markPaid] = repo.createPayment.mock.calls[0] as [RequestContext, VendorPaymentInput, boolean];
      expect(markPaid).toBe(true);
    });

    it('404 when the target invoice does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      expect(await code(service.createPayment(ctx(), { vendorInvoiceId: 999, amount: 100 }))).toBe(404);
    });
  });
});
