import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import { EInvoiceProvider } from '../../services/einvoice/provider';
import { MockEInvoiceProvider } from '../../services/einvoice/mock.provider';
import { TaxRepository, TaxCodeInput } from './tax.repository';
import {
  TaxCode, TaxTransaction, TaxTransactionListResult, GstSplit, GstSummary, EInvoiceResult,
  EwayBillResult,
} from './tax.types';
import {
  CreateTaxCodeDto, TaxCodeQueryDto, GenerateEInvoiceDto, GenerateEwayBillDto,
  TxnQueryDto, SummaryQueryDto,
} from './tax.dto';
import {
  SupplyType, SUPPLY_TYPE, EINVOICE_ELIGIBLE_STATUS, EINVOICE_GENERATED_EVENT,
  EWAY_BILL_GENERATED_EVENT, TAX_DOC_TYPE_INVOICE,
} from './tax.constants';

/**
 * Split a document's total tax into GST heads by place of supply. This is the GST
 * rule: an intra-state supply is taxed half as CGST (central) and half as SGST
 * (state); an inter-state supply is taxed wholly as IGST. Pure + exported so it is
 * unit-testable on its own.
 */
export function splitGst(taxAmount: number, supplyType: SupplyType): GstSplit {
  if (supplyType === SUPPLY_TYPE.INTER) {
    return { cgst: 0, sgst: 0, igst: taxAmount };
  }
  const half = taxAmount / 2;
  return { cgst: half, sgst: half, igst: 0 };
}

/**
 * TaxService — business logic for the GST / Tax module (India statutory).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. Owns: the GST rate-master CRUD, e-invoice (IRN) generation
 * with the CGST/SGST/IGST split + GST-ledger posting, e-way bill generation, and
 * the GSTR-style read/summary surface. fin.invoice is read/stamped only — the AR
 * Billing module owns its lifecycle.
 */
export class TaxService {
  private readonly einvoice: EInvoiceProvider;

  /**
   * @param repo      tax repository (DB writes + invoice read/stamp).
   * @param einvoice  e-invoice / e-way provider that produces the IRN / EWB
   *                  artefacts. Defaults to the deterministic mock provider so
   *                  existing behaviour (and unit tests) are unchanged unless a
   *                  live NIC provider is injected by the composition root.
   */
  constructor(
    private readonly repo: TaxRepository,
    einvoice?: EInvoiceProvider,
  ) {
    this.einvoice = einvoice ?? new MockEInvoiceProvider();
  }

  // ---------------------------------------------------------------------
  // Tax-code master.
  // ---------------------------------------------------------------------
  async createTaxCode(ctx: RequestContext, dto: CreateTaxCodeDto): Promise<TaxCode> {
    const existing = await this.repo.findTaxCodeByCode(ctx, dto.code);
    if (existing) throw Errors.conflict(`Tax code '${dto.code}' already exists`);
    const input: TaxCodeInput = {
      code: dto.code,
      cgstRate: dto.cgstRate ?? 0,
      sgstRate: dto.sgstRate ?? 0,
      igstRate: dto.igstRate ?? 0,
      isActive: dto.isActive ?? true,
    };
    return this.repo.createTaxCode(ctx, input);
  }

  listTaxCodes(ctx: RequestContext, query: TaxCodeQueryDto): Promise<TaxCode[]> {
    return this.repo.listTaxCodes(ctx, query);
  }

  async getTaxCode(ctx: RequestContext, id: number): Promise<TaxCode> {
    const row = await this.repo.findTaxCodeById(ctx, id);
    if (!row) throw Errors.notFound(`Tax code ${id} not found`);
    return row;
  }

  async setActive(ctx: RequestContext, id: number, isActive: boolean): Promise<TaxCode> {
    const updated = await this.repo.setActive(ctx, id, isActive);
    if (!updated) throw Errors.notFound(`Tax code ${id} not found`);
    return updated;
  }

  // ---------------------------------------------------------------------
  // E-invoice (IRN) generation.
  // ---------------------------------------------------------------------
  /**
   * Generate the e-invoice / IRN for an invoice. Guards:
   *   * 404 if the invoice does not exist (in this company),
   *   * 409 unless status is POSTED or SENT (a DRAFT is not yet a legal invoice;
   *     CANCELLED / paid-flow states must not be (re-)reported),
   *   * 409 (idempotency) if it already carries an IRN.
   * Computes the GST split from the invoice's tax_amount, then atomically stamps
   * irn/ack_no, posts the fin.tax_transaction ledger row, and emits
   * 'einvoice.generated' (transactional outbox).
   */
  async generateEInvoice(
    ctx: RequestContext, invoiceId: number, dto: GenerateEInvoiceDto,
  ): Promise<EInvoiceResult> {
    const inv = await this.repo.findInvoice(ctx, invoiceId);
    if (!inv) throw Errors.notFound(`Invoice ${invoiceId} not found`);
    if (!EINVOICE_ELIGIBLE_STATUS.includes(inv.status as (typeof EINVOICE_ELIGIBLE_STATUS)[number])) {
      throw Errors.conflict(
        `An e-invoice can only be raised for a ${EINVOICE_ELIGIBLE_STATUS.join('/')} invoice (current: ${inv.status})`);
    }
    if (inv.irn) {
      throw Errors.conflict(`Invoice ${inv.invoiceNo} already has an IRN`, { irn: inv.irn });
    }

    const split = splitGst(inv.taxAmount, dto.supplyType);
    // Produce the IRN / ack via the configured provider (mock by default, or the
    // live NIC IRP when configured). The provider only mints the artefacts; the
    // repository still performs every DB write below, atomically.
    const result = await this.einvoice.generateIrn(inv, split);
    const { irn, ackNo } = result;
    const event: OutboxEventInput = {
      eventType: EINVOICE_GENERATED_EVENT,
      aggregateType: TAX_DOC_TYPE_INVOICE,
      aggregateId: inv.invoiceId,
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        invoiceNo: inv.invoiceNo,
        irn,
        taxableAmount: inv.taxableAmount,
        totalTax: split.cgst + split.sgst + split.igst,
      },
    };

    const txn = await this.repo.applyEInvoice(ctx, inv, irn, ackNo, split, event);
    // null => a concurrent request stamped the IRN first (lost the race).
    if (!txn) throw Errors.conflict(`Invoice ${inv.invoiceNo} already has an IRN`);
    return { irn, ackNo, cgst: split.cgst, sgst: split.sgst, igst: split.igst };
  }

  // ---------------------------------------------------------------------
  // E-way bill generation.
  // ---------------------------------------------------------------------
  /**
   * Generate the e-way bill number for an invoice. Requires the invoice to already
   * carry an IRN (e-invoice first; else 409) and to not already have an e-way bill
   * (409). Stamps a mock 12-digit number on fin.invoice and emits
   * 'eway_bill.generated' (transactional outbox).
   */
  async generateEwayBill(
    ctx: RequestContext, invoiceId: number, dto: GenerateEwayBillDto,
  ): Promise<EwayBillResult> {
    const inv = await this.repo.findInvoice(ctx, invoiceId);
    if (!inv) throw Errors.notFound(`Invoice ${invoiceId} not found`);
    if (!inv.irn) {
      throw Errors.conflict(`Invoice ${inv.invoiceNo} must be e-invoiced (IRN) before an e-way bill`);
    }
    if (inv.ewayBillNo) {
      throw Errors.conflict(`Invoice ${inv.invoiceNo} already has an e-way bill`, { ewayBillNo: inv.ewayBillNo });
    }

    // The provider mints the EWB number (mock by default, or NIC by IRN when
    // configured); the repository then stamps it on fin.invoice + emits the event.
    const eway = await this.einvoice.generateEwayBill(inv, {
      transporterId: dto.transporterId,
      vehicleNo: dto.vehicleNo,
      mode: dto.transportMode,
      distanceKm: dto.distanceKm,
    });
    const ewayBillNo = eway.ewbNo;
    const event: OutboxEventInput = {
      eventType: EWAY_BILL_GENERATED_EVENT,
      aggregateType: TAX_DOC_TYPE_INVOICE,
      aggregateId: inv.invoiceId,
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: { invoiceNo: inv.invoiceNo, ewayBillNo },
    };

    const ok = await this.repo.applyEwayBill(ctx, inv.invoiceId, ewayBillNo, event);
    if (!ok) throw Errors.conflict(`Invoice ${inv.invoiceNo} already has an e-way bill`);
    return { ewayBillNo };
  }

  // ---------------------------------------------------------------------
  // GST ledger reads.
  // ---------------------------------------------------------------------
  listTransactions(ctx: RequestContext, query: TxnQueryDto): Promise<TaxTransactionListResult> {
    return this.repo.listTransactions(ctx, query);
  }

  async gstSummary(ctx: RequestContext, query: SummaryQueryDto): Promise<GstSummary> {
    if (query.fromDate > query.toDate) {
      throw Errors.badRequest('fromDate must be on or before toDate');
    }
    return this.repo.summarise(ctx, query);
  }

  /** TAX.EXPORT — CSV of the GST register (the filtered ledger). */
  async exportCsv(ctx: RequestContext, query: TxnQueryDto): Promise<string> {
    const { rows } = await this.repo.listTransactions(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Txn Id', 'Doc Type', 'Doc Id', 'Txn Date', 'Taxable Amount', 'CGST', 'SGST', 'IGST'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.taxTxnId, r.docType, r.docId, r.txnDate, r.taxableAmount, r.cgst, r.sgst, r.igst,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
