import { QuotationService } from '../src/modules/quotation/quotation.service';
import { QuotationRepository } from '../src/modules/quotation/quotation.repository';
import { EnquiryRepository } from '../src/modules/enquiry/enquiry.repository';
import { PdfService } from '../src/services/pdf.service';
import { EmailService } from '../src/services/email.service';
import { RequestContext } from '../src/common/request-context';
import { Quotation } from '../src/modules/quotation/quotation.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'fin', companyId: 1, buId: 1, clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};
const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

function quote(over: Partial<Quotation> = {}): Quotation {
  return {
    quotationId: 1, quotationNo: 'QTN/MUM/2026-27/000001', companyId: 1, buId: 1, enquiryId: null,
    currentRevision: 0, subject: 'X', customerName: 'Acme', contact: null, email: 'a@a.com',
    quoteDate: '2026-06-06', validUntil: null, currencyCode: 'INR', totalCost: 80, totalPrice: 100,
    discountPct: 0, marginPct: 20, status: 'DRAFT', sentAt: null, sentTo: null, pdfRef: null,
    createdBy: 1, createdAt: 't', rowVersion: 1, lines: [], ...over,
  };
}
function deps() {
  const repo = { create: jest.fn(), findById: jest.fn(), list: jest.fn(), update: jest.fn(),
    updateStatus: jest.fn(), revise: jest.fn(), listRevisions: jest.fn() } as unknown as jest.Mocked<QuotationRepository>;
  const enq = { findById: jest.fn(), changeStatus: jest.fn() } as unknown as jest.Mocked<EnquiryRepository>;
  const pdf = { generateQuotationPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-')) } as unknown as jest.Mocked<PdfService>;
  const email = { send: jest.fn().mockResolvedValue({ messageId: 'm1', to: 'a@a.com' }) } as unknown as jest.Mocked<EmailService>;
  return { repo, enq, pdf, email, svc: new QuotationService(repo, enq, pdf, email) };
}

describe('QuotationService', () => {
  it('create computes price = gross minus discount', async () => {
    const d = deps();
    d.repo.create.mockResolvedValue(quote());
    await d.svc.create(ctx, { customerName: 'Acme', currencyCode: 'INR', totalCost: 80, discountPct: 10,
      lines: [{ description: 'A', qty: 2, unitPrice: 100, isOptional: false }] });
    // header is the 2nd arg to repo.create(ctx, header, lines): 2*100=200, less 10% = 180
    const headerArg = d.repo.create.mock.calls[0][1];
    expect(headerArg.totalPrice).toBe(180);
  });

  it('create requires a branch (400)', async () => {
    const d = deps();
    await expect(code(d.svc.create({ ...ctx, buId: null }, { customerName: 'A', currencyCode: 'INR', totalCost: 0, discountPct: 0, lines: [{ description: 'a', qty: 1, unitPrice: 1, isOptional: false }] }))).resolves.toBe(400);
  });

  describe('convertFromEnquiry (sync)', () => {
    it('404 when enquiry missing', async () => {
      const d = deps(); d.enq.findById.mockResolvedValue(null);
      await expect(code(d.svc.convertFromEnquiry(ctx, 9, { currencyCode: 'INR' }))).resolves.toBe(404);
    });
    it('409 unless enquiry is QUALIFIED', async () => {
      const d = deps(); d.enq.findById.mockResolvedValue({ status: 'NEW', enquiryId: 9, rowVersion: 1 } as never);
      await expect(code(d.svc.convertFromEnquiry(ctx, 9, { currencyCode: 'INR' }))).resolves.toBe(409);
    });
    it('creates the quote and moves the enquiry to QUOTED', async () => {
      const d = deps();
      d.enq.findById.mockResolvedValue({ status: 'QUALIFIED', enquiryId: 9, rowVersion: 2, customerName: 'Acme', contact: null, email: null, requirement: 'cranes' } as never);
      d.repo.create.mockResolvedValue(quote({ enquiryId: 9 }));
      const out = await d.svc.convertFromEnquiry(ctx, 9, { currencyCode: 'INR' });
      expect(out.enquiryId).toBe(9);
      expect(d.enq.changeStatus).toHaveBeenCalledWith(ctx, 9, 2, 'QUOTED', null);
    });
  });

  describe('approval flow', () => {
    it('submit moves DRAFT -> PENDING_APPROVAL and flags approval need', async () => {
      const d = deps();
      d.repo.findById.mockResolvedValue(quote({ status: 'DRAFT' }));
      d.repo.updateStatus.mockResolvedValue(quote({ status: 'PENDING_APPROVAL', marginPct: 12 }));
      const out = await d.svc.submit(ctx, 1, 1);
      expect(out.quotation.status).toBe('PENDING_APPROVAL');
      expect(out.requiresApproval).toBe(true); // margin 12 < 15
    });
    it('approve only from PENDING_APPROVAL', async () => {
      const d = deps(); d.repo.findById.mockResolvedValue(quote({ status: 'DRAFT' }));
      await expect(code(d.svc.approve(ctx, 1, 1))).resolves.toBe(409);
    });
    it('reject requires a reason', async () => {
      const d = deps(); d.repo.findById.mockResolvedValue(quote({ status: 'PENDING_APPROVAL' }));
      await expect(code(d.svc.reject(ctx, 1, 1, undefined))).resolves.toBe(400);
    });
  });

  describe('send', () => {
    it('409 unless APPROVED/SENT', async () => {
      const d = deps(); d.repo.findById.mockResolvedValue(quote({ status: 'DRAFT' }));
      await expect(code(d.svc.send(ctx, 1, { rowVersion: 1 }))).resolves.toBe(409);
    });
    it('400 when no recipient', async () => {
      const d = deps(); d.repo.findById.mockResolvedValue(quote({ status: 'APPROVED', email: null }));
      await expect(code(d.svc.send(ctx, 1, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('generates PDF, emails it, and marks SENT', async () => {
      const d = deps();
      d.repo.findById.mockResolvedValue(quote({ status: 'APPROVED', email: 'a@a.com' }));
      d.repo.updateStatus.mockResolvedValue(quote({ status: 'SENT' }));
      const out = await d.svc.send(ctx, 1, { rowVersion: 1 });
      expect(d.pdf.generateQuotationPdf).toHaveBeenCalled();
      expect(d.email.send).toHaveBeenCalled();
      expect(out.messageId).toBe('m1');
      expect(out.quotation.status).toBe('SENT');
    });
  });

  describe('won (sync back to enquiry)', () => {
    it('marks WON and converts the linked enquiry', async () => {
      const d = deps();
      d.repo.findById.mockResolvedValue(quote({ status: 'SENT', enquiryId: 9 }));
      d.repo.updateStatus.mockResolvedValue(quote({ status: 'WON', enquiryId: 9 }));
      d.enq.findById.mockResolvedValue({ status: 'QUOTED', enquiryId: 9, rowVersion: 3 } as never);
      await d.svc.markWon(ctx, 1, 1);
      expect(d.enq.changeStatus).toHaveBeenCalledWith(ctx, 9, 3, 'CONVERTED', null);
    });
  });

  it('revise refuses terminal quotes', async () => {
    const d = deps(); d.repo.findById.mockResolvedValue(quote({ status: 'WON' }));
    await expect(code(d.svc.revise(ctx, 1, 1, 'x'))).resolves.toBe(409);
  });
});
