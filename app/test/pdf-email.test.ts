import { PdfService, QuotationPdfModel } from '../src/services/pdf.service';
import { OutboxTransport, EmailService } from '../src/services/email.service';

const model: QuotationPdfModel = {
  quotationNo: 'QTN/MUM/2026-27/000001', revisionLabel: 'Rev A', subject: 'Cranes',
  customerName: 'Tata Projects Ltd', contact: 'R. Iyer', email: 'r@tp.com',
  quoteDate: '2026-06-06', validUntil: '2026-07-06', currencyCode: 'INR',
  lines: [{ description: 'EOT Crane 50T', qty: 2, unitPrice: 5000000, lineAmount: 10000000, isOptional: false }],
  totalCost: 8000000, totalPrice: 9500000, discountPct: 5, marginPct: 15.8,
};

describe('PdfService', () => {
  it('produces a real PDF buffer (%PDF header)', async () => {
    const buf = await new PdfService().generateQuotationPdf(model);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('EmailService + OutboxTransport', () => {
  it('records a sent message with its attachment', async () => {
    const transport = new OutboxTransport();
    const svc = new EmailService(transport);
    const res = await svc.send({
      to: 'r@tp.com', subject: 'Quotation', text: 'hello',
      attachments: [{ filename: 'q.pdf', content: Buffer.from('%PDF-'), contentType: 'application/pdf' }],
    });
    expect(res.messageId).toBeTruthy();
    expect(transport.outbox).toHaveLength(1);
    expect(transport.outbox[0].to).toBe('r@tp.com');
    expect(transport.outbox[0].attachments?.[0].filename).toBe('q.pdf');
  });
});
