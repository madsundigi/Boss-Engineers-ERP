import PDFDocument from 'pdfkit';

export interface QuotationPdfModel {
  quotationNo: string;
  revisionLabel: string; // e.g. "Rev B"
  subject: string | null;
  customerName: string;
  contact: string | null;
  email: string | null;
  quoteDate: string;
  validUntil: string | null;
  currencyCode: string;
  lines: { description: string; qty: number; unitPrice: number; lineAmount: number; isOptional: boolean }[];
  totalCost: number;
  totalPrice: number;
  discountPct: number;
  marginPct: number;
}

/** Generates the quotation PDF (pure-JS pdfkit; no system/headless deps). */
export class PdfService {
  generateQuotationPdf(m: QuotationPdfModel): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const money = (n: number) => `${m.currencyCode} ${n.toLocaleString('en-IN')}`;

      doc.fontSize(18).text('Boss Engineers', { continued: false });
      doc.fontSize(10).fillColor('#666').text('Quotation / Proposal');
      doc.moveDown();

      doc.fillColor('#000').fontSize(14).text(`${m.quotationNo}  (${m.revisionLabel})`);
      if (m.subject) doc.fontSize(11).fillColor('#333').text(m.subject);
      doc.moveDown(0.5).fontSize(10).fillColor('#000');
      doc.text(`To: ${m.customerName}${m.contact ? ' — ' + m.contact : ''}`);
      if (m.email) doc.text(`Email: ${m.email}`);
      doc.text(`Date: ${m.quoteDate}${m.validUntil ? '   Valid until: ' + m.validUntil : ''}`);
      doc.moveDown();

      // Line items
      doc.fontSize(11).fillColor('#000').text('Items', { underline: true });
      doc.moveDown(0.3).fontSize(10);
      m.lines.forEach((l, i) => {
        const tag = l.isOptional ? ' (optional)' : '';
        doc.text(
          `${i + 1}. ${l.description}${tag}  —  ${l.qty} x ${money(l.unitPrice)} = ${money(l.lineAmount)}`,
        );
      });
      doc.moveDown();

      // Totals
      doc.fontSize(11);
      if (m.discountPct > 0) doc.text(`Discount: ${m.discountPct}%`);
      doc.text(`Total Price: ${money(m.totalPrice)}`, { continued: false });
      doc.fontSize(8).fillColor('#888').text(`(internal: cost ${money(m.totalCost)}, margin ${m.marginPct.toFixed(1)}%)`);
      doc.moveDown(2).fontSize(9).fillColor('#666')
        .text('This is a system-generated quotation. Terms & conditions apply.', { align: 'center' });

      doc.end();
    });
  }
}
