import { Pool } from 'pg';
import { OutboxHandler, OutboxRecord } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { PdfService } from '../../services/pdf.service';
import { EmailService } from '../../services/email.service';
import { QuotationRepository } from './quotation.repository';
import { buildQuotationPdfModel } from './quotation.service';

/** A non-interactive, tenant-scoped context for an outbox handler. */
function systemContext(e: OutboxRecord): RequestContext {
  return {
    userId: e.createdBy ?? 0, username: 'system', companyId: e.companyId ?? 0,
    buId: null, clientIp: '0.0.0.0', sessionId: `outbox-${e.eventId}`, permissions: new Set(),
  };
}

/**
 * Handler for 'quotation.sent': render the quotation PDF and email it. Runs in
 * the relay AFTER the SENT state has committed. Idempotent enough for retries —
 * re-delivery only re-sends the same document.
 */
export function quotationSentHandler(pool: Pool, pdf: PdfService, email: EmailService): OutboxHandler {
  const repo = new QuotationRepository(pool);
  return async (e: OutboxRecord): Promise<void> => {
    if (e.aggregateId == null) return;
    const quote = await repo.findById(systemContext(e), e.aggregateId);
    if (!quote) return; // quotation no longer exists; nothing to deliver
    const to = (e.payload.to as string | null) ?? quote.email;
    if (!to) return;
    const buf = await pdf.generateQuotationPdf(buildQuotationPdfModel(quote));
    await email.send({
      to,
      cc: (e.payload.cc as string | null) ?? undefined,
      subject: `Quotation ${quote.quotationNo} from Boss Engineers`,
      text: (e.payload.message as string | null)
        ?? `Dear ${quote.contact ?? quote.customerName},\n\nPlease find attached our quotation ${quote.quotationNo}.\n\nRegards,\nBoss Engineers`,
      attachments: [{ filename: `${quote.quotationNo}.pdf`, content: buf, contentType: 'application/pdf' }],
    });
  };
}
