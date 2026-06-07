import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  PayablesRepository, VendorInvoiceHeaderInput, VendorInvoiceLineInput, VendorInvoiceHeaderPatch,
} from './payables.repository';
import {
  VendorInvoice, VendorPayment, VendorInvoiceListResult, ListResult,
} from './payables.types';
import {
  CreateVendorInvoiceDto, UpdateVendorInvoiceDto, DisputeDto, ListQueryDto,
  CreatePaymentDto, PaymentListQueryDto,
} from './payables.dto';
import {
  canTransition, VENDOR_INVOICE_APPROVED_EVENT, VENDOR_INVOICE_AGGREGATE,
} from './payables.constants';

/** Round to 4dp (numeric(20,4)) to keep float accumulation off the persisted total. */
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e4) / 1e4;
}

/** total_amount is the Σ of the supplied line amounts. */
export function sumLineAmounts(lines: { amount: number }[]): number {
  return round4(lines.reduce((s, l) => s + l.amount, 0));
}

/**
 * PayablesService — business logic for Accounts Payable (vendor invoices &
 * payments). Stateless; depends only on the repository (injected) so it is
 * unit-testable without a database. Drives the 3-way-match lifecycle
 * (PENDING -> MATCHED -> APPROVED -> PAID, with DISPUTED off any non-PAID state)
 * and the payment flow (payments accumulate against an APPROVED bill and flip it
 * to PAID once fully settled).
 */
export class PayablesService {
  constructor(private readonly repo: PayablesRepository) {}

  private mapLines(dto: CreateVendorInvoiceDto['lines']): VendorInvoiceLineInput[] {
    return dto.map((l) => ({ itemId: l.itemId, qty: l.qty, unitRate: l.unitRate, amount: l.amount }));
  }

  async create(ctx: RequestContext, dto: CreateVendorInvoiceDto): Promise<VendorInvoice> {
    const lines = this.mapLines(dto.lines);
    const header: VendorInvoiceHeaderInput = {
      vinvNo: dto.vinvNo, vendorId: dto.vendorId, poId: dto.poId, grnId: dto.grnId,
      invoiceDate: dto.invoiceDate,
    };
    return this.repo.create(ctx, header, lines, sumLineAmounts(lines));
  }

  async getById(ctx: RequestContext, id: number): Promise<VendorInvoice> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Vendor invoice ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<VendorInvoiceListResult> {
    return this.repo.list(ctx, query);
  }

  /** Replace header + lines — only allowed while PENDING. Recomputes total_amount. */
  async update(ctx: RequestContext, id: number, dto: UpdateVendorInvoiceDto): Promise<VendorInvoice> {
    const { rowVersion, lines, ...rest } = dto;
    const fields = rest as VendorInvoiceHeaderPatch;
    if (Object.keys(fields).length === 0 && !lines) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status !== 'PENDING') {
      throw Errors.conflict(`Only a PENDING vendor invoice can be edited (current: ${existing.status})`);
    }
    const mapped = lines ? this.mapLines(lines) : undefined;
    const updated = await this.repo.update(
      ctx, id, rowVersion, fields, mapped, mapped ? sumLineAmounts(mapped) : existing.totalAmount,
    );
    if (!updated) {
      throw Errors.conflict('Vendor invoice was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * 3-way match (PENDING -> MATCHED). Represents PO / GRN / invoice reconciliation.
   * When a PO is linked we sanity-check the invoice total against the PO total
   * (off here means a quantity/price discrepancy — block with 409 so it is routed
   * to dispute instead). With no PO linked the match is allowed unconditionally.
   */
  async match(ctx: RequestContext, id: number, rowVersion: number): Promise<VendorInvoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'MATCHED')) {
      throw Errors.conflict(`Only a PENDING vendor invoice can be matched (current: ${existing.status})`);
    }
    if (existing.poId != null) {
      const poTotal = await this.repo.poTotal(ctx, existing.poId);
      if (poTotal != null && round4(poTotal) !== round4(existing.totalAmount)) {
        throw Errors.conflict(
          `3-way match failed: invoice total ${existing.totalAmount} does not match PO total ${poTotal}`,
          { invoiceTotal: existing.totalAmount, poTotal },
        );
      }
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'MATCHED');
    if (!updated) throw Errors.conflict('Vendor invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  /**
   * Approve a matched bill for payment (MATCHED -> APPROVED). Emits
   * 'vendor_invoice.approved' atomically with the state change (transactional
   * outbox) so AP ageing / cash-flow / GL accrual react downstream.
   */
  async approve(ctx: RequestContext, id: number, rowVersion: number): Promise<VendorInvoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'APPROVED')) {
      throw Errors.conflict(`Only a MATCHED vendor invoice can be approved (current: ${existing.status})`);
    }
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, 'APPROVED', {
      eventType: VENDOR_INVOICE_APPROVED_EVENT, aggregateType: VENDOR_INVOICE_AGGREGATE, aggregateId: id,
      companyId: ctx.companyId, createdBy: ctx.userId,
      payload: { vinvNo: existing.vinvNo, vendorId: existing.vendorId, totalAmount: existing.totalAmount },
    });
    if (!updated) throw Errors.conflict('Vendor invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  /** Put a non-PAID bill into dispute (* -> DISPUTED). */
  async dispute(ctx: RequestContext, id: number, dto: DisputeDto): Promise<VendorInvoice> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'DISPUTED')) {
      throw Errors.conflict(`Cannot dispute a vendor invoice in status ${existing.status}`);
    }
    const updated = await this.repo.updateStatus(ctx, id, dto.rowVersion, 'DISPUTED');
    if (!updated) throw Errors.conflict('Vendor invoice was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number): Promise<void> {
    const existing = await this.getById(ctx, id);
    if (existing.status !== 'PENDING') {
      throw Errors.conflict(`Only a PENDING vendor invoice can be deleted (current: ${existing.status})`);
    }
    await this.repo.softDelete(ctx, id);
  }

  /** AP_INVOICE.EXPORT — CSV of the (filtered) vendor-invoice list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Vendor Invoice No', 'Vendor', 'PO', 'Invoice Date', 'Total Amount', 'Status', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.vinvNo, r.vendorId, r.poId, r.invoiceDate, r.totalAmount, r.status, r.createdAt].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  // =========================================================================
  // Vendor payments
  // =========================================================================

  /**
   * Record a payment against an APPROVED vendor invoice. A branch (buId) is
   * required to allocate the 'VPAY' number. The cumulative paid amount may not
   * exceed the invoice total (else 400); when it reaches the total the invoice
   * is flipped to PAID in the same transaction as the payment insert.
   */
  async createPayment(ctx: RequestContext, dto: CreatePaymentDto): Promise<VendorPayment> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a vendor payment number');
    }
    const invoice = await this.getById(ctx, dto.vendorInvoiceId); // 404 if missing
    if (invoice.status !== 'APPROVED') {
      throw Errors.conflict(`Payments can only be recorded against an APPROVED vendor invoice (current: ${invoice.status})`);
    }
    const alreadyPaid = await this.repo.paidTotal(ctx, invoice.vendorInvoiceId);
    const newTotal = round4(alreadyPaid + dto.amount);
    if (newTotal > round4(invoice.totalAmount)) {
      throw Errors.badRequest(
        `Payment exceeds the outstanding balance: paying ${dto.amount} would settle ${newTotal} against a total of ${invoice.totalAmount}`,
        { alreadyPaid, attempted: dto.amount, total: invoice.totalAmount },
      );
    }
    const markPaid = newTotal >= round4(invoice.totalAmount);
    return this.repo.createPayment(
      ctx,
      { vendorId: invoice.vendorId, vendorInvoiceId: invoice.vendorInvoiceId, amount: dto.amount, payDate: dto.payDate },
      markPaid,
    );
  }

  listPayments(ctx: RequestContext, query: PaymentListQueryDto): Promise<ListResult<VendorPayment>> {
    return this.repo.listPayments(ctx, query);
  }

  /** AP_INVOICE.EXPORT — CSV of the (filtered) payment list. */
  async exportPaymentsCsv(ctx: RequestContext, query: PaymentListQueryDto): Promise<string> {
    const { rows } = await this.repo.listPayments(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Payment No', 'Vendor', 'Vendor Invoice', 'Pay Date', 'Amount'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r: VendorPayment) =>
      [r.vpayNo, r.vendorId, r.vendorInvoiceId, r.payDate, r.amount].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
