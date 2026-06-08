import { createHash } from 'node:crypto';
import { InvoiceForTax } from '../../modules/tax/tax.types';
import {
  EInvoiceProvider, EInvoiceResult, EwayResult, EwayTransport, InvoiceGstSplit,
} from './provider';

/**
 * Offline, deterministic e-invoice provider — the DEFAULT.
 *
 * Reproduces the historical inline mock byte-for-byte so the GST/Tax behaviour
 * (and its unit tests) are unchanged when no NIC credentials are configured:
 *   * IRN  = sha256(`${companyId}|${invoiceNo}|${totalAmount}`)  -> 64 hex chars
 *   * ack  = 'ACK' + zero-padded(invoiceId, 10)
 *   * EWB  = first 12 decimal digits of sha256(`EWB|${companyId}|${invoiceNo}|${irn}`)
 *
 * No external calls; same invoice -> same artefacts (idempotent + testable).
 */
export class MockEInvoiceProvider implements EInvoiceProvider {
  readonly name = 'mock';

  async generateIrn(invoice: InvoiceForTax, _split: InvoiceGstSplit): Promise<EInvoiceResult> {
    const irn = mockIrn(invoice);
    return {
      irn,
      ackNo: mockAckNo(invoice.invoiceId),
      ackDate: invoice.invoiceDate,
      signedQrCode: undefined,
      status: 'ACT', // NIC: ACT = active IRN
    };
  }

  async cancelIrn(_irn: string, _reason: string): Promise<void> {
    // No-op in the mock: there is no external IRP to call back.
  }

  async generateEwayBill(invoice: InvoiceForTax, _transport: EwayTransport): Promise<EwayResult> {
    return { ewbNo: mockEwayBillNo(invoice), validUpto: undefined, status: 'ACT' };
  }
}

/**
 * Deterministic MOCK IRN: the real GST IRP returns a 64-char hex hash of the
 * signed invoice. We emulate that surface with a sha256 of a stable invoice key
 * so the same invoice always yields the same 64-hex IRN.
 */
export function mockIrn(inv: InvoiceForTax): string {
  return createHash('sha256')
    .update(`${inv.companyId}|${inv.invoiceNo}|${inv.totalAmount}`)
    .digest('hex'); // 64 hex chars
}

/** Mock acknowledgement number: 'ACK' + zero-padded invoice id (e.g. ACK0000000042). */
export function mockAckNo(invoiceId: number): string {
  return `ACK${String(invoiceId).padStart(10, '0')}`;
}

/**
 * Mock 12-digit e-way bill number. The real EWB API issues a 12-digit number;
 * derive a stable 12 digits from the invoice's IRN/id so it is deterministic.
 */
export function mockEwayBillNo(inv: InvoiceForTax): string {
  const digits = createHash('sha256')
    .update(`EWB|${inv.companyId}|${inv.invoiceNo}|${inv.irn ?? ''}`)
    .digest('hex')
    .replace(/\D/g, ''); // keep only decimal digits from the hex
  return (digits + '000000000000').slice(0, 12);
}
