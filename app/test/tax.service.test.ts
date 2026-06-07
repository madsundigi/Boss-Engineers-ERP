import { TaxService, splitGst } from '../src/modules/tax/tax.service';
import { TaxRepository } from '../src/modules/tax/tax.repository';
import { RequestContext } from '../src/common/request-context';
import { TaxCode, TaxTransaction, InvoiceForTax, GstSummary } from '../src/modules/tax/tax.types';
import { OutboxEventInput } from '../src/outbox/outbox';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 9, username: 'finance', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function invoice(over: Partial<InvoiceForTax> = {}): InvoiceForTax {
  return {
    invoiceId: 42, companyId: 1, invoiceNo: 'INV/BE/2026/000042',
    invoiceDate: '2026-06-07', taxableAmount: 100000, taxAmount: 18000, totalAmount: 118000,
    status: 'POSTED', irn: null, ackNo: null, ewayBillNo: null, ...over,
  };
}
function txn(over: Partial<TaxTransaction> = {}): TaxTransaction {
  return {
    taxTxnId: 5, companyId: 1, docType: 'INVOICE', docId: 42, txnDate: '2026-06-07',
    taxableAmount: 100000, cgst: 9000, sgst: 9000, igst: 0, ...over,
  };
}
function taxCode(over: Partial<TaxCode> = {}): TaxCode {
  return { taxCodeId: 1, code: 'GST18', cgstRate: 9, sgstRate: 9, igstRate: 0, isActive: true, ...over };
}

function makeRepo() {
  return {
    createTaxCode: jest.fn(),
    findTaxCodeById: jest.fn(),
    findTaxCodeByCode: jest.fn(),
    listTaxCodes: jest.fn(),
    setActive: jest.fn(),
    findInvoice: jest.fn(),
    applyEInvoice: jest.fn(),
    applyEwayBill: jest.fn(),
    listTransactions: jest.fn(),
    summarise: jest.fn(),
  } as unknown as jest.Mocked<TaxRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('splitGst (pure GST split)', () => {
  it('INTRA splits the tax into equal CGST + SGST, zero IGST', () => {
    expect(splitGst(18000, 'INTRA')).toEqual({ cgst: 9000, sgst: 9000, igst: 0 });
  });
  it('INTER puts the whole tax in IGST, zero CGST/SGST', () => {
    expect(splitGst(18000, 'INTER')).toEqual({ cgst: 0, sgst: 0, igst: 18000 });
  });
  it('handles an odd amount without losing the rupee (cgst+sgst == tax)', () => {
    const s = splitGst(18001, 'INTRA');
    expect(s.cgst + s.sgst).toBe(18001);
    expect(s.igst).toBe(0);
  });
});

describe('TaxService', () => {
  let repo: jest.Mocked<TaxRepository>;
  let service: TaxService;
  beforeEach(() => { repo = makeRepo(); service = new TaxService(repo); });

  describe('createTaxCode', () => {
    it('creates with rate defaults of 0 and is_active true', async () => {
      repo.findTaxCodeByCode.mockResolvedValue(null);
      repo.createTaxCode.mockResolvedValue(taxCode());
      await service.createTaxCode(ctx, { code: 'GST18', cgstRate: 9, sgstRate: 9 });
      expect(repo.createTaxCode).toHaveBeenCalledWith(ctx, {
        code: 'GST18', cgstRate: 9, sgstRate: 9, igstRate: 0, isActive: true,
      });
    });
    it('409 on a duplicate code', async () => {
      repo.findTaxCodeByCode.mockResolvedValue(taxCode());
      await expect(code(service.createTaxCode(ctx, { code: 'GST18' }))).resolves.toBe(409);
      expect(repo.createTaxCode).not.toHaveBeenCalled();
    });
  });

  describe('getTaxCode / setActive', () => {
    it('404 when getTaxCode misses', async () => {
      repo.findTaxCodeById.mockResolvedValue(null);
      await expect(code(service.getTaxCode(ctx, 99))).resolves.toBe(404);
    });
    it('404 when setActive targets an unknown id', async () => {
      repo.setActive.mockResolvedValue(null);
      await expect(code(service.setActive(ctx, 99, false))).resolves.toBe(404);
    });
    it('returns the updated row when setActive hits', async () => {
      const updated = taxCode({ isActive: false });
      repo.setActive.mockResolvedValue(updated);
      await expect(service.setActive(ctx, 1, false)).resolves.toBe(updated);
    });
  });

  describe('generateEInvoice', () => {
    it('404 when the invoice does not exist', async () => {
      repo.findInvoice.mockResolvedValue(null);
      await expect(code(service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' }))).resolves.toBe(404);
    });

    it('409 when the invoice is not POSTED/SENT (e.g. DRAFT)', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ status: 'DRAFT' }));
      await expect(code(service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' }))).resolves.toBe(409);
      expect(repo.applyEInvoice).not.toHaveBeenCalled();
    });

    it('409 when the invoice already carries an IRN (idempotency)', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ irn: 'a'.repeat(64) }));
      await expect(code(service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' }))).resolves.toBe(409);
      expect(repo.applyEInvoice).not.toHaveBeenCalled();
    });

    it('allows a SENT invoice to be e-invoiced', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ status: 'SENT' }));
      repo.applyEInvoice.mockResolvedValue(txn());
      await expect(code(service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' }))).resolves.toBe(0);
    });

    it('INTRA: ledger split cgst=sgst=tax/2, igst=0; returns a 64-hex IRN + ACK', async () => {
      repo.findInvoice.mockResolvedValue(invoice());
      repo.applyEInvoice.mockResolvedValue(txn());
      const out = await service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' });
      expect(out.cgst).toBe(9000);
      expect(out.sgst).toBe(9000);
      expect(out.igst).toBe(0);
      expect(out.irn).toMatch(/^[0-9a-f]{64}$/);
      expect(out.ackNo).toBe('ACK0000000042');
      // the split passed to the repo matches the returned split
      const [, , , , split, event] = repo.applyEInvoice.mock.calls[0];
      expect(split).toEqual({ cgst: 9000, sgst: 9000, igst: 0 });
      // the outbox event carries invoiceNo / irn / taxableAmount / totalTax
      const e = event as OutboxEventInput;
      expect(e.eventType).toBe('einvoice.generated');
      expect(e.payload).toMatchObject({
        invoiceNo: 'INV/BE/2026/000042', taxableAmount: 100000, totalTax: 18000,
      });
    });

    it('INTER: ledger split igst=tax, cgst=sgst=0', async () => {
      repo.findInvoice.mockResolvedValue(invoice());
      repo.applyEInvoice.mockResolvedValue(txn({ cgst: 0, sgst: 0, igst: 18000 }));
      const out = await service.generateEInvoice(ctx, 42, { supplyType: 'INTER' });
      expect(out.cgst).toBe(0);
      expect(out.sgst).toBe(0);
      expect(out.igst).toBe(18000);
      const [, , , , split] = repo.applyEInvoice.mock.calls[0];
      expect(split).toEqual({ cgst: 0, sgst: 0, igst: 18000 });
    });

    it('produces a deterministic IRN for the same invoice', async () => {
      repo.findInvoice.mockResolvedValue(invoice());
      repo.applyEInvoice.mockResolvedValue(txn());
      const a = await service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' });
      const b = await service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' });
      expect(a.irn).toBe(b.irn);
    });

    it('409 when the repo reports the IRN was stamped concurrently (race)', async () => {
      repo.findInvoice.mockResolvedValue(invoice());
      repo.applyEInvoice.mockResolvedValue(null);
      await expect(code(service.generateEInvoice(ctx, 42, { supplyType: 'INTRA' }))).resolves.toBe(409);
    });
  });

  describe('generateEwayBill', () => {
    it('404 when the invoice does not exist', async () => {
      repo.findInvoice.mockResolvedValue(null);
      await expect(code(service.generateEwayBill(ctx, 42, {}))).resolves.toBe(404);
    });

    it('409 when the invoice has no IRN yet (must e-invoice first)', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ irn: null }));
      await expect(code(service.generateEwayBill(ctx, 42, {}))).resolves.toBe(409);
      expect(repo.applyEwayBill).not.toHaveBeenCalled();
    });

    it('409 when the invoice already has an e-way bill', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ irn: 'a'.repeat(64), ewayBillNo: '123456789012' }));
      await expect(code(service.generateEwayBill(ctx, 42, {}))).resolves.toBe(409);
      expect(repo.applyEwayBill).not.toHaveBeenCalled();
    });

    it('generates a 12-digit e-way bill once an IRN exists, emits the event', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ irn: 'a'.repeat(64) }));
      repo.applyEwayBill.mockResolvedValue(true);
      const out = await service.generateEwayBill(ctx, 42, { transporter: 'BlueDart' });
      expect(out.ewayBillNo).toMatch(/^\d{12}$/);
      const [, , ewayBillNo, event] = repo.applyEwayBill.mock.calls[0];
      expect(ewayBillNo).toBe(out.ewayBillNo);
      const e = event as OutboxEventInput;
      expect(e.eventType).toBe('eway_bill.generated');
      expect(e.payload).toMatchObject({ invoiceNo: 'INV/BE/2026/000042', ewayBillNo: out.ewayBillNo });
    });

    it('409 when the repo reports the e-way bill was stamped concurrently', async () => {
      repo.findInvoice.mockResolvedValue(invoice({ irn: 'a'.repeat(64) }));
      repo.applyEwayBill.mockResolvedValue(false);
      await expect(code(service.generateEwayBill(ctx, 42, {}))).resolves.toBe(409);
    });
  });

  describe('gstSummary', () => {
    it('400 when fromDate is after toDate', async () => {
      await expect(code(service.gstSummary(ctx, { fromDate: '2026-12-31', toDate: '2026-01-01' }))).resolves.toBe(400);
      expect(repo.summarise).not.toHaveBeenCalled();
    });
    it('passes the range to the repo and returns its aggregation', async () => {
      const summary: GstSummary = {
        fromDate: '2026-04-01', toDate: '2026-06-30',
        taxableAmount: 300000, cgst: 18000, sgst: 18000, igst: 9000, totalTax: 45000, count: 3,
      };
      repo.summarise.mockResolvedValue(summary);
      const out = await service.gstSummary(ctx, { fromDate: '2026-04-01', toDate: '2026-06-30' });
      expect(out).toBe(summary);
      expect(repo.summarise).toHaveBeenCalledWith(ctx, { fromDate: '2026-04-01', toDate: '2026-06-30' });
    });
  });

  describe('listTransactions', () => {
    it('passes filters + pagination straight through to the repo', async () => {
      const result = { rows: [txn()], total: 1, page: 2, pageSize: 10 };
      repo.listTransactions.mockResolvedValue(result);
      const out = await service.listTransactions(ctx, { docType: 'INVOICE', page: 2, pageSize: 10 });
      expect(out).toBe(result);
      expect(repo.listTransactions).toHaveBeenCalledWith(ctx, { docType: 'INVOICE', page: 2, pageSize: 10 });
    });
  });
});
