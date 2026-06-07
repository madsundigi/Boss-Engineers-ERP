import { BillingService } from '../src/modules/billing/billing.service';
import { BillingRepository, ComputedLine, InvoiceHeaderInput, ReceiptInput } from '../src/modules/billing/billing.repository';
import { RequestContext } from '../src/common/request-context';
import { OutboxEventInput } from '../src/outbox/outbox';
import { Invoice, Receipt, Advance, Retention } from '../src/modules/billing/billing.types';
import { INVOICE_POSTED_EVENT, PAYMENT_RECEIVED_EVENT } from '../src/modules/billing/billing.constants';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'finance', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    invoiceId: 30, invoiceNo: 'INV/MUM/2026-27/000030', companyId: 1, buId: 1,
    projectId: 100, customerId: 50, milestoneId: null, invoiceDate: '2026-06-07',
    currencyId: 1, taxableAmount: 1000, taxAmount: 180, totalAmount: 1180,
    status: 'DRAFT', createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    lines: [], ...over,
  };
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    receiptId: 7, receiptNo: 'RCT/MUM/2026-27/000007', companyId: 1, customerId: 50,
    receiptDate: '2026-06-07', amount: 1000, mode: 'NEFT', reference: 'UTR1',
    allocations: [], ...over,
  };
}

function advance(over: Partial<Advance> = {}): Advance {
  return {
    advanceId: 3, projectId: 100, customerId: 50, advanceDate: '2026-06-07',
    amount: 1000, adjustedAmount: 0, ...over,
  };
}

function retention(over: Partial<Retention> = {}): Retention {
  return {
    retentionId: 9, projectId: 100, invoiceId: 30, retainedAmount: 1000,
    releaseDueDate: null, releasedAmount: 0, status: 'HELD', ...over,
  };
}

function makeRepo() {
  return {
    fetchTaxRates: jest.fn(),
    resolveInrCurrencyId: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
    fetchInvoiceOutstanding: jest.fn(),
    createReceipt: jest.fn(),
    findReceipt: jest.fn(),
    listReceipts: jest.fn(),
    createAdvance: jest.fn(),
    findAdvance: jest.fn(),
    listAdvances: jest.fn(),
    adjustAdvance: jest.fn(),
    createRetention: jest.fn(),
    findRetention: jest.fn(),
    listRetentions: jest.fn(),
    releaseRetention: jest.fn(),
    recognizeRevenue: jest.fn(),
    listRevenue: jest.fn(),
  } as unknown as jest.Mocked<BillingRepository>;
}

/** Resolve a service call to its HTTP status code (0 on success). */
const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('BillingService', () => {
  let repo: jest.Mocked<BillingRepository>;
  let service: BillingService;
  beforeEach(() => {
    repo = makeRepo();
    service = new BillingService(repo);
    repo.fetchTaxRates.mockResolvedValue(new Map());
    repo.resolveInrCurrencyId.mockResolvedValue(1);
  });

  // ------------------------------------------------------------------
  describe('create — amount computation', () => {
    it('computes line + header amounts from qty x unit_rate (no tax code -> tax 0)', async () => {
      repo.create.mockResolvedValue(invoice());
      await service.create(ctx, {
        customerId: 50,
        lines: [{ description: 'Pump skid', qty: 2, unitRate: 500 }],
      });
      const [, header, lines] = repo.create.mock.calls[0] as [RequestContext, InvoiceHeaderInput, ComputedLine[]];
      expect(lines[0]).toMatchObject({ taxableAmount: 1000, taxAmount: 0 });
      expect(header).toMatchObject({ taxableAmount: 1000, taxAmount: 0, totalAmount: 1000 });
    });

    it('applies the combined tax_code rate (cgst+sgst+igst) to the line tax', async () => {
      // tax code 4 -> 18% combined (e.g. 9 + 9). taxable 1000 -> tax 180, total 1180.
      repo.fetchTaxRates.mockResolvedValue(new Map([[4, 18]]));
      repo.create.mockResolvedValue(invoice());
      await service.create(ctx, {
        customerId: 50,
        lines: [{ description: 'Pump skid', qty: 1, unitRate: 1000, taxCodeId: 4 }],
      });
      const [, header, lines] = repo.create.mock.calls[0] as [RequestContext, InvoiceHeaderInput, ComputedLine[]];
      expect(lines[0]).toMatchObject({ taxableAmount: 1000, taxAmount: 180 });
      expect(header).toMatchObject({ taxableAmount: 1000, taxAmount: 180, totalAmount: 1180 });
    });

    it('sums taxable + tax across multiple lines for the header', async () => {
      repo.fetchTaxRates.mockResolvedValue(new Map([[4, 18]]));
      repo.create.mockResolvedValue(invoice());
      await service.create(ctx, {
        customerId: 50,
        lines: [
          { description: 'A', qty: 1, unitRate: 1000, taxCodeId: 4 }, // 1000 + 180
          { description: 'B', qty: 2, unitRate: 100 },                // 200 + 0
        ],
      });
      const [, header] = repo.create.mock.calls[0] as [RequestContext, InvoiceHeaderInput, ComputedLine[]];
      expect(header).toMatchObject({ taxableAmount: 1200, taxAmount: 180, totalAmount: 1380 });
    });

    it('rejects an unknown tax code (400) rather than silently zero-taxing', async () => {
      repo.fetchTaxRates.mockResolvedValue(new Map()); // code 99 not resolved
      expect(await code(service.create(ctx, {
        customerId: 50, lines: [{ description: 'X', qty: 1, unitRate: 100, taxCodeId: 99 }],
      }))).toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('resolves INR when no currency is supplied', async () => {
      repo.resolveInrCurrencyId.mockResolvedValue(77);
      repo.create.mockResolvedValue(invoice());
      await service.create(ctx, { customerId: 50, lines: [{ description: 'X', qty: 1, unitRate: 100 }] });
      const [, header] = repo.create.mock.calls[0] as [RequestContext, InvoiceHeaderInput, ComputedLine[]];
      expect(header.currencyId).toBe(77);
    });

    it('rejects (400) when no branch context to allocate a number', async () => {
      expect(await code(service.create({ ...ctx, buId: null }, {
        customerId: 50, lines: [{ description: 'X', qty: 1, unitRate: 100 }],
      }))).toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      expect(await code(service.getById(ctx, 99))).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  describe('post — DRAFT -> POSTED + outbox', () => {
    it('posts a DRAFT invoice and emits invoice.posted with the financial payload', async () => {
      repo.findById.mockResolvedValue(invoice());
      repo.updateStatus.mockResolvedValue(invoice({ status: 'POSTED', rowVersion: 2 }));
      const out = await service.post(ctx, 30, 1);
      expect(out.status).toBe('POSTED');
      const event = repo.updateStatus.mock.calls[0][4] as OutboxEventInput;
      expect(event.eventType).toBe(INVOICE_POSTED_EVENT);
      expect(event.aggregateType).toBe('INVOICE');
      expect(event.payload).toMatchObject({
        invoiceNo: 'INV/MUM/2026-27/000030', customerId: 50, projectId: 100,
        totalAmount: 1180, taxableAmount: 1000,
      });
    });

    it('409 when posting a non-DRAFT invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'POSTED' }));
      expect(await code(service.post(ctx, 30, 1))).toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(invoice());
      repo.updateStatus.mockResolvedValue(null);
      expect(await code(service.post(ctx, 30, 1))).toBe(409);
    });
  });

  // ------------------------------------------------------------------
  describe('markSent / cancel transition guards', () => {
    it('markSent: 409 unless POSTED', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'DRAFT' }));
      expect(await code(service.markSent(ctx, 30, 1))).toBe(409);
    });
    it('markSent: POSTED -> SENT', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'POSTED' }));
      repo.updateStatus.mockResolvedValue(invoice({ status: 'SENT', rowVersion: 2 }));
      expect((await service.markSent(ctx, 30, 1)).status).toBe('SENT');
    });
    it('cancel: 409 from a terminal PAID invoice', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PAID' }));
      expect(await code(service.cancel(ctx, 30, { reason: 'x', rowVersion: 1 }))).toBe(409);
    });
    it('cancel: a PARTIALLY_PAID invoice -> CANCELLED', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'PARTIALLY_PAID' }));
      repo.updateStatus.mockResolvedValue(invoice({ status: 'CANCELLED', rowVersion: 2 }));
      expect((await service.cancel(ctx, 30, { reason: 'dispute', rowVersion: 1 })).status).toBe('CANCELLED');
    });
  });

  // ------------------------------------------------------------------
  describe('update', () => {
    it('409 when not DRAFT', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'POSTED' }));
      expect(await code(service.update(ctx, 30, {
        rowVersion: 1, lines: [{ description: 'X', qty: 1, unitRate: 100 }],
      }))).toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(invoice());
      repo.update.mockResolvedValue(null);
      expect(await code(service.update(ctx, 30, {
        rowVersion: 1, lines: [{ description: 'X', qty: 1, unitRate: 100 }],
      }))).toBe(409);
    });
    it('recomputes amounts on a successful edit', async () => {
      repo.findById.mockResolvedValue(invoice());
      repo.update.mockResolvedValue(invoice({ rowVersion: 2 }));
      await service.update(ctx, 30, { rowVersion: 1, lines: [{ description: 'X', qty: 3, unitRate: 100 }] });
      const [, , , header, lines] = repo.update.mock.calls[0] as
        [RequestContext, number, number, InvoiceHeaderInput, ComputedLine[]];
      expect(lines[0].taxableAmount).toBe(300);
      expect(header.totalAmount).toBe(300);
    });
  });

  // ------------------------------------------------------------------
  describe('delete', () => {
    it('409 unless DRAFT', async () => {
      repo.findById.mockResolvedValue(invoice({ status: 'POSTED' }));
      expect(await code(service.delete(ctx, 30))).toBe(409);
    });
    it('soft-deletes a DRAFT invoice', async () => {
      repo.findById.mockResolvedValue(invoice());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
  });

  // ------------------------------------------------------------------
  describe('createReceipt — allocation validation', () => {
    it('records a receipt with no allocations and emits payment.received', async () => {
      repo.createReceipt.mockResolvedValue(receipt());
      const out = await service.createReceipt(ctx, { customerId: 50, amount: 1000 });
      expect(out).toEqual(receipt());
      const [, input, event] = repo.createReceipt.mock.calls[0] as [RequestContext, ReceiptInput, OutboxEventInput];
      expect(input.allocations).toHaveLength(0);
      expect(event.eventType).toBe(PAYMENT_RECEIVED_EVENT);
      expect(event.payload).toMatchObject({ customerId: 50, amount: 1000, allocated: 0 });
    });

    it('rejects (400) when allocations exceed the receipt amount', async () => {
      repo.fetchInvoiceOutstanding.mockResolvedValue(new Map([
        [30, { status: 'POSTED', total: 2000, allocated: 0 }],
      ]));
      expect(await code(service.createReceipt(ctx, {
        customerId: 50, amount: 1000, allocations: [{ invoiceId: 30, allocatedAmount: 1500 }],
      }))).toBe(400);
      expect(repo.createReceipt).not.toHaveBeenCalled();
    });

    it('rejects (400) when an allocation exceeds the invoice outstanding balance', async () => {
      // invoice total 1000, already 800 allocated -> only 200 remaining; ask for 500.
      repo.fetchInvoiceOutstanding.mockResolvedValue(new Map([
        [30, { status: 'PARTIALLY_PAID', total: 1000, allocated: 800 }],
      ]));
      expect(await code(service.createReceipt(ctx, {
        customerId: 50, amount: 500, allocations: [{ invoiceId: 30, allocatedAmount: 500 }],
      }))).toBe(400);
      expect(repo.createReceipt).not.toHaveBeenCalled();
    });

    it('rejects (400) allocating to a DRAFT (non-allocatable) invoice', async () => {
      repo.fetchInvoiceOutstanding.mockResolvedValue(new Map([
        [30, { status: 'DRAFT', total: 1000, allocated: 0 }],
      ]));
      expect(await code(service.createReceipt(ctx, {
        customerId: 50, amount: 1000, allocations: [{ invoiceId: 30, allocatedAmount: 1000 }],
      }))).toBe(400);
    });

    it('rejects (400) allocating to an unknown invoice', async () => {
      repo.fetchInvoiceOutstanding.mockResolvedValue(new Map());
      expect(await code(service.createReceipt(ctx, {
        customerId: 50, amount: 1000, allocations: [{ invoiceId: 999, allocatedAmount: 100 }],
      }))).toBe(400);
    });

    it('accepts a valid full allocation (drives PAID downstream in the repo)', async () => {
      repo.fetchInvoiceOutstanding.mockResolvedValue(new Map([
        [30, { status: 'POSTED', total: 1000, allocated: 0 }],
      ]));
      repo.createReceipt.mockResolvedValue(receipt({
        allocations: [{ allocationId: 1, receiptId: 7, invoiceId: 30, allocatedAmount: 1000 }],
      }));
      const out = await service.createReceipt(ctx, {
        customerId: 50, amount: 1000, allocations: [{ invoiceId: 30, allocatedAmount: 1000 }],
      });
      expect(out.allocations).toHaveLength(1);
      const [, input] = repo.createReceipt.mock.calls[0] as [RequestContext, ReceiptInput, OutboxEventInput];
      expect(input.allocations[0]).toMatchObject({ invoiceId: 30, allocatedAmount: 1000 });
    });

    it('rejects (400) when no branch context to allocate a receipt number', async () => {
      expect(await code(service.createReceipt({ ...ctx, buId: null }, { customerId: 50, amount: 100 }))).toBe(400);
    });
  });

  describe('getReceipt', () => {
    it('404 when not found', async () => {
      repo.findReceipt.mockResolvedValue(null);
      expect(await code(service.getReceipt(ctx, 99))).toBe(404);
    });
  });

  // ------------------------------------------------------------------
  describe('advances', () => {
    it('adjustAdvance: 404 when unknown', async () => {
      repo.findAdvance.mockResolvedValue(null);
      expect(await code(service.adjustAdvance(ctx, 3, { amount: 100 }))).toBe(404);
    });
    it('adjustAdvance: 400 when the adjustment over-consumes the advance', async () => {
      repo.findAdvance.mockResolvedValue(advance({ amount: 1000, adjustedAmount: 900 }));
      expect(await code(service.adjustAdvance(ctx, 3, { amount: 200 }))).toBe(400); // 1100 > 1000
      expect(repo.adjustAdvance).not.toHaveBeenCalled();
    });
    it('adjustAdvance: increases adjusted_amount within the cap', async () => {
      repo.findAdvance.mockResolvedValue(advance({ amount: 1000, adjustedAmount: 200 }));
      repo.adjustAdvance.mockResolvedValue(advance({ adjustedAmount: 500 }));
      const out = await service.adjustAdvance(ctx, 3, { amount: 300 });
      expect(out.adjustedAmount).toBe(500);
      expect(repo.adjustAdvance).toHaveBeenCalledWith(ctx, 3, 300);
    });
  });

  // ------------------------------------------------------------------
  describe('retention — release math', () => {
    it('404 when the retention is unknown', async () => {
      repo.findRetention.mockResolvedValue(null);
      expect(await code(service.releaseRetention(ctx, 9, { amount: 100 }))).toBe(404);
    });
    it('partial release -> status PARTIAL with the running released_amount', async () => {
      repo.findRetention.mockResolvedValue(retention({ retainedAmount: 1000, releasedAmount: 0 }));
      repo.releaseRetention.mockResolvedValue(retention({ releasedAmount: 400, status: 'PARTIAL' }));
      const out = await service.releaseRetention(ctx, 9, { amount: 400 });
      expect(out.status).toBe('PARTIAL');
      expect(repo.releaseRetention).toHaveBeenCalledWith(ctx, 9, 400, 'PARTIAL');
    });
    it('full release -> status RELEASED', async () => {
      repo.findRetention.mockResolvedValue(retention({ retainedAmount: 1000, releasedAmount: 600, status: 'PARTIAL' }));
      repo.releaseRetention.mockResolvedValue(retention({ releasedAmount: 1000, status: 'RELEASED' }));
      const out = await service.releaseRetention(ctx, 9, { amount: 400 }); // 600 + 400 = 1000
      expect(out.status).toBe('RELEASED');
      expect(repo.releaseRetention).toHaveBeenCalledWith(ctx, 9, 1000, 'RELEASED');
    });
    it('400 when releasing more than the remaining retention', async () => {
      repo.findRetention.mockResolvedValue(retention({ retainedAmount: 1000, releasedAmount: 800 }));
      expect(await code(service.releaseRetention(ctx, 9, { amount: 300 }))).toBe(400); // 1100 > 1000
      expect(repo.releaseRetention).not.toHaveBeenCalled();
    });
    it('409 when the retention is already fully RELEASED', async () => {
      repo.findRetention.mockResolvedValue(retention({ status: 'RELEASED', releasedAmount: 1000 }));
      expect(await code(service.releaseRetention(ctx, 9, { amount: 1 }))).toBe(409);
    });
  });

  // ------------------------------------------------------------------
  describe('revenue recognition', () => {
    it('defaults the method to MILESTONE when omitted', async () => {
      repo.recognizeRevenue.mockResolvedValue({
        revId: 1, projectId: 100, milestoneId: null, recognitionDate: '2026-06-07',
        method: 'MILESTONE', amount: 5000,
      });
      await service.recognizeRevenue(ctx, { projectId: 100, amount: 5000 });
      const [, arg] = repo.recognizeRevenue.mock.calls[0];
      expect(arg).toMatchObject({ method: 'MILESTONE', amount: 5000 });
    });
  });
});
