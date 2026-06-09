import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { EnquiryRepository } from '../enquiry/enquiry.repository';
import { PdfService, QuotationPdfModel } from '../../services/pdf.service';
import { QuotationRepository, QuotationHeaderInput } from './quotation.repository';
import { Quotation, QuotationLine } from './quotation.types';
import {
  CreateQuotationDto, UpdateQuotationDto, ConvertDto, SendDto, ListQueryDto,
} from './quotation.dto';
import { requiresApproval, revisionLabel, QuoteStatus } from './quotation.constants';
import Decimal from 'decimal.js';

/** gross * (1 - discountPct/100), rounded to 2dp at the money boundary. */
const applyDiscount = (gross: Decimal, discountPct: number): number =>
  gross.mul(new Decimal(1).minus(new Decimal(discountPct).div(100))).toDecimalPlaces(2).toNumber();

/** Map a quotation to the PDF render model (shared by the API and the outbox handler). */
export function buildQuotationPdfModel(q: Quotation): QuotationPdfModel {
  return {
    quotationNo: q.quotationNo, revisionLabel: revisionLabel(q.currentRevision), subject: q.subject,
    customerName: q.customerName, contact: q.contact, email: q.email, quoteDate: q.quoteDate,
    validUntil: q.validUntil, currencyCode: q.currencyCode, lines: q.lines,
    totalCost: q.totalCost, totalPrice: q.totalPrice, discountPct: q.discountPct, marginPct: q.marginPct,
  };
}

/** send() now queues delivery via the outbox; email is dispatched by the relay after commit. */
export interface SendResult { quotation: Quotation; queued: boolean; to: string; }

export class QuotationService {
  constructor(
    private readonly repo: QuotationRepository,
    private readonly enquiries: EnquiryRepository,
    private readonly pdf: PdfService,
  ) {}

  private price(lines: { description: string; qty: number; unitPrice: number; isOptional?: boolean }[]) {
    const mapped: QuotationLine[] = lines.map((l) => ({
      description: l.description, qty: l.qty, unitPrice: l.unitPrice,
      lineAmount: new Decimal(l.qty).mul(l.unitPrice).toDecimalPlaces(2).toNumber(), isOptional: !!l.isOptional,
    }));
    const gross = mapped
      .filter((l) => !l.isOptional)
      .reduce((s, l) => s.plus(new Decimal(l.qty).mul(l.unitPrice)), new Decimal(0));
    return { mapped, gross };
  }

  async create(ctx: RequestContext, dto: CreateQuotationDto): Promise<Quotation> {
    if (!ctx.buId) throw Errors.badRequest('A branch (x-bu-id) is required to allocate a quotation number');
    const { mapped, gross } = this.price(dto.lines);
    const header: QuotationHeaderInput = {
      subject: dto.subject, customerName: dto.customerName, contact: dto.contact, email: dto.email,
      validUntil: dto.validUntil, currencyCode: dto.currencyCode, totalCost: dto.totalCost,
      totalPrice: applyDiscount(gross, dto.discountPct), discountPct: dto.discountPct, enquiryId: dto.enquiryId,
      taxPct: dto.taxPct, deliveryTerms: dto.deliveryTerms, paymentTerms: dto.paymentTerms, warrantyTerms: dto.warrantyTerms,
    };
    return this.repo.create(ctx, header, mapped);
  }

  /** Sync with Enquiry: create a draft quotation from a QUALIFIED enquiry. */
  async convertFromEnquiry(ctx: RequestContext, enquiryId: number, dto: ConvertDto): Promise<Quotation> {
    if (!ctx.buId) throw Errors.badRequest('A branch (x-bu-id) is required');
    const enq = await this.enquiries.findById(ctx, enquiryId);
    if (!enq) throw Errors.notFound(`Enquiry ${enquiryId} not found`);
    if (enq.status !== 'QUALIFIED') {
      throw Errors.conflict(`Enquiry must be QUALIFIED to quote (current: ${enq.status})`);
    }
    const line: QuotationLine = {
      description: enq.requirement || 'As per enquiry', qty: 1, unitPrice: 0, lineAmount: 0, isOptional: false,
    };
    const quote = await this.repo.create(ctx, {
      subject: dto.subject ?? (enq.requirement ? enq.requirement.slice(0, 200) : 'Quotation'),
      customerName: enq.customerName, contact: enq.contact ?? undefined, email: enq.email ?? undefined,
      validUntil: dto.validUntil, currencyCode: dto.currencyCode, totalCost: 0, totalPrice: 0,
      discountPct: 0, enquiryId,
    }, [line]);
    // sync the enquiry forward (best-effort; same transaction boundary is a future enhancement)
    await this.enquiries.changeStatus(ctx, enquiryId, enq.rowVersion, 'QUOTED', null);
    return quote;
  }

  async getById(ctx: RequestContext, id: number): Promise<Quotation> {
    const q = await this.repo.findById(ctx, id);
    if (!q) throw Errors.notFound(`Quotation ${id} not found`);
    return q;
  }
  list(ctx: RequestContext, query: ListQueryDto) { return this.repo.list(ctx, query); }
  listRevisions(ctx: RequestContext, id: number) { return this.repo.listRevisions(ctx, id); }

  async update(ctx: RequestContext, id: number, dto: UpdateQuotationDto): Promise<Quotation> {
    const { rowVersion, lines, ...rest } = dto;
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
      throw Errors.conflict(`Revise the quotation before editing (status ${existing.status}). Use /revise.`);
    }
    const fields: Partial<QuotationHeaderInput> = { ...rest };
    const discountPct = dto.discountPct ?? existing.discountPct;
    let mapped: QuotationLine[] | undefined;
    if (lines) {
      const p = this.price(lines); mapped = p.mapped;
      fields.totalPrice = applyDiscount(p.gross, discountPct);
    } else if (dto.discountPct !== undefined) {
      const gross = existing.lines
        .filter((l) => !l.isOptional)
        .reduce((s, l) => s.plus(new Decimal(l.qty).mul(l.unitPrice)), new Decimal(0));
      fields.totalPrice = applyDiscount(gross, discountPct);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, fields, mapped);
    if (!updated) throw Errors.conflict('Quotation was modified by someone else (row version mismatch)');
    return updated;
  }

  async submit(ctx: RequestContext, id: number, rowVersion: number): Promise<{ quotation: Quotation; requiresApproval: boolean }> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') throw Errors.conflict(`Only a DRAFT can be submitted (status ${existing.status})`);
    const q = await this.repo.updateStatus(ctx, id, rowVersion, 'PENDING_APPROVAL', {
      submitted_at: new Date(), submitted_by: ctx.userId,
    });
    if (!q) throw Errors.conflict('Row version mismatch');
    return { quotation: q, requiresApproval: requiresApproval(q.marginPct, q.discountPct) };
  }

  async approve(ctx: RequestContext, id: number, rowVersion: number): Promise<Quotation> {
    const existing = await this.getById(ctx, id);
    if (existing.createdBy === ctx.userId) {
      throw Errors.forbidden('Segregation of Duties: you cannot approve a quotation you created');
    }
    if (existing.status !== 'PENDING_APPROVAL') throw Errors.conflict(`Only a PENDING_APPROVAL quote can be approved (status ${existing.status})`);
    const q = await this.repo.updateStatus(ctx, id, rowVersion, 'APPROVED', { decided_at: new Date(), decided_by: ctx.userId });
    if (!q) throw Errors.conflict('Row version mismatch');
    return q;
  }

  async reject(ctx: RequestContext, id: number, rowVersion: number, reason?: string): Promise<Quotation> {
    if (!reason) throw Errors.badRequest('A reason is required to reject');
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PENDING_APPROVAL') throw Errors.conflict(`Only a PENDING_APPROVAL quote can be rejected (status ${existing.status})`);
    const q = await this.repo.updateStatus(ctx, id, rowVersion, 'REJECTED', {
      decided_at: new Date(), decided_by: ctx.userId, decision_reason: reason,
    });
    if (!q) throw Errors.conflict('Row version mismatch');
    return q;
  }

  async revise(ctx: RequestContext, id: number, rowVersion: number, reason: string): Promise<Quotation> {
    const existing = await this.getById(ctx, id);
    if (existing.status === 'WON' || existing.status === 'LOST') throw Errors.conflict(`Cannot revise a ${existing.status} quotation`);
    const q = await this.repo.revise(ctx, id, rowVersion, reason);
    if (!q) throw Errors.conflict('Row version mismatch');
    return q;
  }

  async generatePdf(ctx: RequestContext, id: number): Promise<{ quotation: Quotation; pdf: Buffer }> {
    const q = await this.getById(ctx, id);
    return { quotation: q, pdf: await this.pdf.generateQuotationPdf(buildQuotationPdfModel(q)) };
  }

  /**
   * Transition to SENT and queue delivery via the transactional outbox: the
   * status change and the 'quotation.sent' event commit atomically (one tx).
   * The relay then renders the PDF and emails it AFTER commit (fixes BW-02:
   * no email is sent for a state change that didn't persist; retries on failure).
   */
  async send(ctx: RequestContext, id: number, dto: SendDto): Promise<SendResult> {
    const existing = await this.getById(ctx, id);
    const sendable: QuoteStatus[] = ['APPROVED', 'SENT', 'NEGOTIATION'];
    if (!sendable.includes(existing.status)) {
      throw Errors.conflict(`Quotation must be APPROVED before sending (status ${existing.status})`);
    }
    const to = dto.to ?? existing.email;
    if (!to) throw Errors.badRequest('No recipient email (provide "to" or set the quotation email)');
    const pdfRef = `quotations/${existing.quotationNo}-rev${existing.currentRevision}.pdf`;
    const q = await this.repo.updateStatus(
      ctx, id, dto.rowVersion, 'SENT',
      { sent_at: new Date(), sent_to: to, pdf_ref: pdfRef },
      {
        eventType: 'quotation.sent', aggregateType: 'QUOTATION', aggregateId: id,
        companyId: ctx.companyId, createdBy: ctx.userId,
        payload: { to, cc: dto.cc ?? null, message: dto.message ?? null },
      },
    );
    if (!q) throw Errors.conflict('Row version mismatch');
    return { quotation: q, queued: true, to };
  }

  async markWon(ctx: RequestContext, id: number, rowVersion: number): Promise<Quotation> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'SENT' && existing.status !== 'NEGOTIATION') {
      throw Errors.conflict(`Only a SENT/NEGOTIATION quote can be won (status ${existing.status})`);
    }
    // Emit 'quotation.won' so the project module auto-seeds a Project (FRD §5).
    const q = await this.repo.updateStatus(ctx, id, rowVersion, 'WON', {}, {
      eventType: 'quotation.won', aggregateType: 'QUOTATION', aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { quotationNo: existing.quotationNo },
    });
    if (!q) throw Errors.conflict('Row version mismatch');
    // sync: the originating enquiry is now CONVERTED
    if (existing.enquiryId) {
      const enq = await this.enquiries.findById(ctx, existing.enquiryId);
      if (enq && enq.status === 'QUOTED') await this.enquiries.changeStatus(ctx, enq.enquiryId, enq.rowVersion, 'CONVERTED', null);
    }
    return q;
  }

  async markLost(ctx: RequestContext, id: number, rowVersion: number, reason?: string): Promise<Quotation> {
    const existing = await this.getById(ctx, id);
    if (existing.status === 'WON' || existing.status === 'LOST') throw Errors.conflict(`Already ${existing.status}`);
    const q = await this.repo.updateStatus(ctx, id, rowVersion, 'LOST', reason ? { decision_reason: reason } : {});
    if (!q) throw Errors.conflict('Row version mismatch');
    if (existing.enquiryId) {
      const enq = await this.enquiries.findById(ctx, existing.enquiryId);
      if (enq && enq.status === 'QUOTED') await this.enquiries.changeStatus(ctx, enq.enquiryId, enq.rowVersion, 'LOST', null);
    }
    return q;
  }
}
