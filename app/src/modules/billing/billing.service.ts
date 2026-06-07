import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import {
  BillingRepository, ComputedLine, InvoiceHeaderInput, ReceiptInput,
} from './billing.repository';
import {
  Invoice, InvoiceLine, Receipt, Advance, Retention, RevenueEntry,
  InvoiceListResult, ListResult,
} from './billing.types';
import {
  CreateInvoiceDto, UpdateInvoiceDto, CancelDto, ListQueryDto,
  CreateReceiptDto, ReceiptQueryDto, CreateAdvanceDto, AdjustAdvanceDto, AdvanceQueryDto,
  CreateRetentionDto, ReleaseRetentionDto, RetentionQueryDto, RecognizeRevenueDto,
} from './billing.dto';
import {
  canTransition, ALLOCATABLE_STATUSES, InvoiceStatus, RetentionStatus,
  INVOICE_POSTED_EVENT, PAYMENT_RECEIVED_EVENT, DOC_TYPE_INVOICE, DOC_TYPE_RECEIPT,
} from './billing.constants';

/** Money is stored as numeric(20,4); round to 4 dp to dodge float drift. */
const SCALE = 10_000;
function round4(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * BillingService — Accounts Receivable (customer invoices, receipts, allocations,
 * advances, retention, revenue recognition). Stateless; depends only on the
 * repository (injected) so it is unit-testable without a database.
 *
 * Invoice financials are computed here (never trusted from the client): per line
 * taxable = qty x unit_rate, line tax = taxable x (cgst+sgst+igst)/100 when a
 * tax_code is given; the header rolls those up. A DRAFT invoice is editable; POST
 * freezes it and emits 'invoice.posted'. Receipt allocations drive each touched
 * invoice to PARTIALLY_PAID / PAID from the live allocation sum.
 */
export class BillingService {
  constructor(private readonly repo: BillingRepository) {}

  // ---------------------------------------------------------------------
  // Amount computation (the single source of truth for invoice financials).
  // ---------------------------------------------------------------------
  /** Build computed lines + the header roll-up from the DTO lines, resolving each
   *  referenced tax_code's combined rate. */
  private async computeLines(
    ctx: RequestContext, dtoLines: CreateInvoiceDto['lines'],
  ): Promise<{ lines: ComputedLine[]; taxableAmount: number; taxAmount: number; totalAmount: number }> {
    const taxCodeIds = [...new Set(dtoLines.map((l) => l.taxCodeId).filter((x): x is number => x != null))];
    const rates = await this.repo.fetchTaxRates(ctx, taxCodeIds);
    // Reject a line that references an unknown tax_code rather than silently zero-taxing it.
    const missing = taxCodeIds.filter((cid) => !rates.has(cid));
    if (missing.length > 0) {
      throw Errors.badRequest(`Unknown tax code(s): ${missing.join(', ')}`);
    }

    let taxableAmount = 0;
    let taxAmount = 0;
    const lines: ComputedLine[] = dtoLines.map((l) => {
      const lineTaxable = round4(l.qty * l.unitRate);
      const rate = l.taxCodeId != null ? (rates.get(l.taxCodeId) ?? 0) : 0;
      const lineTax = round4(lineTaxable * rate / 100);
      taxableAmount += lineTaxable;
      taxAmount += lineTax;
      return {
        itemId: l.itemId,
        description: l.description,
        qty: l.qty,
        unitRate: l.unitRate,
        taxableAmount: lineTaxable,
        taxCodeId: l.taxCodeId,
        taxAmount: lineTax,
      };
    });
    taxableAmount = round4(taxableAmount);
    taxAmount = round4(taxAmount);
    return { lines, taxableAmount, taxAmount, totalAmount: round4(taxableAmount + taxAmount) };
  }

  /** Resolve the currency to use: the supplied id, else the company's INR. */
  private async resolveCurrency(ctx: RequestContext, supplied?: number): Promise<number> {
    if (supplied != null) return supplied;
    const inr = await this.repo.resolveInrCurrencyId(ctx);
    if (inr == null) throw Errors.badRequest('No currency supplied and INR is not configured');
    return inr;
  }

  // ---------------------------------------------------------------------
  // Invoice CRUD + lifecycle.
  // ---------------------------------------------------------------------
  async create(ctx: RequestContext, dto: CreateInvoiceDto): Promise<Invoice> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate an invoice number');
    }
    const currencyId = await this.resolveCurrency(ctx, dto.currencyId);
    const computed = await this.computeLines(ctx, dto.lines);
    const header: InvoiceHeaderInput = {
      projectId: dto.projectId, customerId: dto.customerId, milestoneId: dto.milestoneId,
      currencyId, invoiceDate: dto.invoiceDate,
      taxableAmount: computed.taxableAmount, taxAmount: computed.taxAmount, totalAmount: computed.totalAmount,
    };
    return this.repo.create(ctx, header, computed.lines);
  }

  async getById(ctx: RequestContext, id: number): Promise<Invoice> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Invoice ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<InvoiceListResult> {
    return this.repo.list(ctx, query);
  }

  async update(ctx: RequestContext, id: number, dto: UpdateInvoiceDto): Promise<Invoice> {
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT invoice can be edited (current: ${existing.status})`);
    }
    const currencyId = await this.resolveCurrency(ctx, dto.currencyId ?? existing.currencyId);
    const computed = await this.computeLines(ctx, dto.lines);
    const header: InvoiceHeaderInput = {
      projectId: dto.projectId, customerId: existing.customerId, milestoneId: dto.milestoneId,
      currencyId, invoiceDate: dto.invoiceDate,
      taxableAmount: computed.taxableAmount, taxAmount: computed.taxAmount, totalAmount: computed.totalAmount,
    };
    const updated = await this.repo.update(ctx, id, dto.rowVersion, header, computed.lines);
    if (!updated) {
      throw Errors.conflict('Invoice was modified by someone else (row version mismatch)', {
        expected: dto.rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Post a DRAFT invoice (DRAFT -> POSTED). Freezes the financials and emits
   * 'invoice.posted' atomically with the status change (transactional outbox).
   */
  async post(ctx: RequestContext, id: number, rowVersion: number): Promise<Invoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'POSTED')) {
      throw Errors.conflict(`Only a DRAFT invoice can be posted (current: ${existing.status})`);
    }
    const event: OutboxEventInput = {
      eventType: INVOICE_POSTED_EVENT,
      aggregateType: DOC_TYPE_INVOICE,
      aggregateId: id,
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        invoiceNo: existing.invoiceNo,
        customerId: existing.customerId,
        projectId: existing.projectId,
        totalAmount: existing.totalAmount,
        taxableAmount: existing.taxableAmount,
      },
    };
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'POSTED', event);
    if (!updated) throw Errors.conflict('Invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Mark a POSTED invoice as SENT (issued to the customer). */
  async markSent(ctx: RequestContext, id: number, rowVersion: number): Promise<Invoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'SENT')) {
      throw Errors.conflict(`Only a POSTED invoice can be marked SENT (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'SENT');
    if (!updated) throw Errors.conflict('Invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Cancel any non-PAID invoice (DRAFT/POSTED/SENT/PARTIALLY_PAID -> CANCELLED). */
  async cancel(ctx: RequestContext, id: number, dto: CancelDto): Promise<Invoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'CANCELLED')) {
      throw Errors.conflict(`Cannot cancel an invoice in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'CANCELLED');
    if (!updated) throw Errors.conflict('Invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'DRAFT') {
      throw Errors.conflict(`Only a DRAFT invoice can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** INVOICE.EXPORT — CSV of the (filtered) invoice list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Invoice No', 'Customer', 'Project', 'Invoice Date', 'Status',
      'Taxable', 'Tax', 'Total', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.invoiceNo, r.customerId, r.projectId, r.invoiceDate, r.status,
        r.taxableAmount, r.taxAmount, r.totalAmount, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // ---------------------------------------------------------------------
  // Receipts & allocation.
  // ---------------------------------------------------------------------
  /**
   * Record a customer receipt, optionally allocating it across invoices. Validates
   * that the allocations sum to <= the receipt amount and each allocation is <=
   * that invoice's outstanding balance (and that the invoice is allocatable).
   * Persisting refreshes each touched invoice to PARTIALLY_PAID / PAID and emits
   * 'payment.received'. Requires ctx.buId (the receipt-number scope).
   */
  async createReceipt(ctx: RequestContext, dto: CreateReceiptDto): Promise<Receipt> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a receipt number');
    }
    const allocations = dto.allocations ?? [];
    const allocTotal = round4(allocations.reduce((s, a) => s + a.allocatedAmount, 0));
    if (allocTotal > round4(dto.amount)) {
      throw Errors.badRequest(
        `Allocations (${allocTotal}) exceed the receipt amount (${dto.amount})`,
      );
    }

    if (allocations.length > 0) {
      const invoiceIds = [...new Set(allocations.map((a) => a.invoiceId))];
      const outstanding = await this.repo.fetchInvoiceOutstanding(ctx, invoiceIds);
      // Aggregate requested allocation per invoice (a receipt may list one twice).
      const requested = new Map<number, number>();
      for (const a of allocations) {
        requested.set(a.invoiceId, round4((requested.get(a.invoiceId) ?? 0) + a.allocatedAmount));
      }
      for (const [invId, want] of requested) {
        const inv = outstanding.get(invId);
        if (!inv) throw Errors.badRequest(`Invoice ${invId} not found for allocation`);
        if (!ALLOCATABLE_STATUSES.includes(inv.status)) {
          throw Errors.badRequest(
            `Invoice ${invId} is ${inv.status}; only a posted/sent/partially-paid invoice can be paid`,
          );
        }
        const remaining = round4(inv.total - inv.allocated);
        if (want > remaining) {
          throw Errors.badRequest(
            `Allocation ${want} exceeds invoice ${invId} outstanding balance (${remaining})`,
          );
        }
      }
    }

    const input: ReceiptInput = {
      customerId: dto.customerId, amount: dto.amount, receiptDate: dto.receiptDate,
      mode: dto.mode, reference: dto.reference, allocations,
    };
    const event: OutboxEventInput = {
      eventType: PAYMENT_RECEIVED_EVENT,
      aggregateType: DOC_TYPE_RECEIPT,
      aggregateId: null, // stamped with the real receipt_id by repo.createReceipt
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        receiptNo: null, // allocated by the DB; consumer reads the row
        customerId: dto.customerId,
        amount: dto.amount,
        allocated: allocTotal,
        invoiceIds: [...new Set(allocations.map((a) => a.invoiceId))],
      },
    };
    return this.repo.createReceipt(ctx, input, event);
  }

  async getReceipt(ctx: RequestContext, id: number): Promise<Receipt> {
    const row = await this.repo.findReceipt(ctx, id);
    if (!row) throw Errors.notFound(`Receipt ${id} not found`);
    return row;
  }

  listReceipts(ctx: RequestContext, query: ReceiptQueryDto): Promise<ListResult<Omit<Receipt, 'allocations'>>> {
    return this.repo.listReceipts(ctx, query);
  }

  // ---------------------------------------------------------------------
  // Advances.
  // ---------------------------------------------------------------------
  createAdvance(ctx: RequestContext, dto: CreateAdvanceDto): Promise<Advance> {
    return this.repo.createAdvance(ctx, {
      projectId: dto.projectId, customerId: dto.customerId, amount: dto.amount, advanceDate: dto.advanceDate,
    });
  }

  listAdvances(ctx: RequestContext, query: AdvanceQueryDto): Promise<Advance[]> {
    return this.repo.listAdvances(ctx, query);
  }

  /**
   * Adjust (consume) part of an advance: increase adjusted_amount by dto.amount,
   * capped at the original amount. 404 if unknown; 400 if the adjustment would
   * over-consume the advance.
   */
  async adjustAdvance(ctx: RequestContext, id: number, dto: AdjustAdvanceDto): Promise<Advance> {
    const existing = await this.repo.findAdvance(ctx, id);
    if (!existing) throw Errors.notFound(`Advance ${id} not found`);
    const newTotal = round4(existing.adjustedAmount + dto.amount);
    if (newTotal > round4(existing.amount)) {
      throw Errors.badRequest(
        `Adjustment ${dto.amount} exceeds the remaining advance (${round4(existing.amount - existing.adjustedAmount)})`,
      );
    }
    const updated = await this.repo.adjustAdvance(ctx, id, dto.amount);
    if (!updated) throw Errors.conflict('Advance was modified concurrently; retry the adjustment');
    return updated;
  }

  // ---------------------------------------------------------------------
  // Retention.
  // ---------------------------------------------------------------------
  createRetention(ctx: RequestContext, dto: CreateRetentionDto): Promise<Retention> {
    return this.repo.createRetention(ctx, {
      projectId: dto.projectId, invoiceId: dto.invoiceId,
      retainedAmount: dto.retainedAmount, releaseDueDate: dto.releaseDueDate,
    });
  }

  listRetentions(ctx: RequestContext, query: RetentionQueryDto): Promise<Retention[]> {
    return this.repo.listRetentions(ctx, query);
  }

  /**
   * Release (part of) held retention. Only a HELD/PARTIAL retention can be
   * released. Adds to released_amount (capped at retained_amount) and sets the
   * status: RELEASED when fully released, else PARTIAL.
   */
  async releaseRetention(ctx: RequestContext, id: number, dto: ReleaseRetentionDto): Promise<Retention> {
    const existing = await this.repo.findRetention(ctx, id);
    if (!existing) throw Errors.notFound(`Retention ${id} not found`);
    if (existing.status === 'RELEASED') {
      throw Errors.conflict('Retention is already fully released');
    }
    const newReleased = round4(existing.releasedAmount + dto.amount);
    if (newReleased > round4(existing.retainedAmount)) {
      throw Errors.badRequest(
        `Release ${dto.amount} exceeds the remaining retention (${round4(existing.retainedAmount - existing.releasedAmount)})`,
      );
    }
    const status: RetentionStatus = newReleased >= round4(existing.retainedAmount) ? 'RELEASED' : 'PARTIAL';
    const updated = await this.repo.releaseRetention(ctx, id, newReleased, status);
    if (!updated) throw Errors.notFound(`Retention ${id} not found`);
    return updated;
  }

  // ---------------------------------------------------------------------
  // Revenue recognition.
  // ---------------------------------------------------------------------
  recognizeRevenue(ctx: RequestContext, dto: RecognizeRevenueDto): Promise<RevenueEntry> {
    return this.repo.recognizeRevenue(ctx, {
      projectId: dto.projectId, milestoneId: dto.milestoneId, recognitionDate: dto.recognitionDate,
      method: dto.method ?? 'MILESTONE', amount: dto.amount,
    });
  }

  listRevenue(ctx: RequestContext, projectId: number): Promise<RevenueEntry[]> {
    return this.repo.listRevenue(ctx, projectId);
  }
}

/** Re-exported so tests can reference the status union without a deep import. */
export type { InvoiceStatus };
