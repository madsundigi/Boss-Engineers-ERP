import { InvoiceForTax } from '../../modules/tax/tax.types';

/**
 * E-invoice (GST IRP / IRN) + e-way-bill provider abstraction.
 *
 * Two implementations ship in this folder:
 *   * `mock.provider.ts` — deterministic, offline, the DEFAULT. Preserves the
 *     historical mock IRN/ack/EWB surface so behaviour is unchanged when no
 *     NIC credentials are configured.
 *   * `nic.provider.ts`  — the real NIC IRP (e-Invoice) + e-Way Bill REST flow,
 *     activated only when `EINVOICE_PROVIDER=nic` AND credentials are present.
 *
 * The provider produces ONLY the IRN / ack / EWB artefacts; the tax repository
 * still owns every database write (stamping fin.invoice + the GST ledger row +
 * the outbox event), so the tax service stays thin. To keep the service
 * unit-testable without a database, the generate* methods accept the already
 * fetched `InvoiceForTax` (which the service has in hand) plus, for IRN, the
 * GST split — rather than re-reading the invoice via runRead.
 */

/** The GST split (CGST/SGST/IGST heads) for a document, as the tax module computes it. */
export interface InvoiceGstSplit {
  cgst: number;
  sgst: number;
  igst: number;
}

/** Optional transport details for an e-way bill consignment. */
export interface EwayTransport {
  transporterId?: string;
  vehicleNo?: string;
  mode?: string;        // road/rail/air/ship — NIC TransMode 1..4
  distanceKm?: number;  // approximate distance; NIC computes if 0
}

/** Result of an IRN generation. ackNo/ackDate/signedQrCode mirror the NIC response. */
export interface EInvoiceResult {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQrCode?: string;
  status: string;
}

/** Result of an e-way-bill generation. */
export interface EwayResult {
  ewbNo: string;
  validUpto?: string;
  status: string;
}

export interface EInvoiceProvider {
  /** Identifier for logging/diagnostics ('mock' | 'nic'). */
  readonly name: string;

  /** Generate the IRN for an invoice (with its already-computed GST split). */
  generateIrn(invoice: InvoiceForTax, split: InvoiceGstSplit): Promise<EInvoiceResult>;

  /** Cancel a previously generated IRN (24h window per NIC rules). */
  cancelIrn(irn: string, reason: string): Promise<void>;

  /** Generate the e-way bill for an invoice that already carries an IRN. */
  generateEwayBill(invoice: InvoiceForTax, transport: EwayTransport): Promise<EwayResult>;
}
