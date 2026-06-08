import { InvoiceGstSplit } from './provider';

/**
 * Builder for the NIC e-Invoice **INV-01** JSON (schema version 1.1) and the
 * e-Way-Bill request, from an enriched invoice projection. Pure + dependency-free
 * so it is unit-tested against a fixture (correct field mapping + GST split).
 *
 * NIC schema reference (e-Invoice 1.1): Version, TranDtls, DocDtls, SellerDtls,
 * BuyerDtls, ItemList[], ValDtls. Money is rounded to 2 dp as NIC requires.
 */

/** Seller (supplier) party — sourced from mdm.company + its registered address. */
export interface SellerDetails {
  gstin: string;
  legalName: string;
  address1: string;
  location: string;
  pincode: number;
  stateCode: string; // GST state code (2-digit), used for intra/inter classification
  address2?: string;
}

/** Buyer (recipient) party — sourced from mdm.customer + its BILL_TO address. */
export interface BuyerDetails {
  gstin: string;
  legalName: string;
  address1: string;
  location: string;
  pincode: number;
  stateCode: string;   // GST state code of the recipient
  posStateCode: string; // place-of-supply state code (usually == stateCode)
  address2?: string;
}

/** One invoice line, enriched with its GST rate (from the line's tax_code). */
export interface InvoiceLineForInv01 {
  slNo: number;
  isService: boolean;
  hsnCode: string;
  description: string;
  qty: number;
  unit: string;       // UQC, e.g. 'NOS', 'KGS'
  unitPrice: number;
  taxableAmount: number;
  gstRatePct: number; // combined GST rate %, e.g. 18
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
}

/** The full enriched invoice the INV-01 builder needs (header + parties + lines). */
export interface InvoiceForInv01 {
  invoiceNo: string;
  invoiceDate: string;   // YYYY-MM-DD (DB) -> reformatted to DD/MM/YYYY for NIC
  supplyType: 'INTRA' | 'INTER';
  seller: SellerDetails;
  buyer: BuyerDetails;
  lines: InvoiceLineForInv01[];
  taxableAmount: number;
  split: InvoiceGstSplit;
  totalAmount: number;
}

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Convert a 'YYYY-MM-DD' date to NIC's required 'DD/MM/YYYY'. */
export function toNicDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Build the INV-01 request object (e-Invoice schema v1.1) for the NIC IRP.
 * IGST is emitted for inter-state supply; CGST+SGST for intra-state.
 */
export function buildInv01(inv: InvoiceForInv01): Record<string, unknown> {
  const inter = inv.supplyType === 'INTER';
  const itemList = inv.lines.map((l) => {
    const totItemVal = r2(l.taxableAmount + l.cgstAmount + l.sgstAmount + l.igstAmount);
    return {
      SlNo: String(l.slNo),
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsnCode,
      PrdDesc: l.description.slice(0, 300),
      Qty: r2(l.qty),
      Unit: l.unit,
      UnitPrice: r2(l.unitPrice),
      TotAmt: r2(l.taxableAmount),
      AssAmt: r2(l.taxableAmount),
      GstRt: r2(l.gstRatePct),
      IgstAmt: r2(l.igstAmount),
      CgstAmt: r2(l.cgstAmount),
      SgstAmt: r2(l.sgstAmount),
      TotItemVal: totItemVal,
    };
  });

  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: inv.invoiceNo, Dt: toNicDate(inv.invoiceDate) },
    SellerDtls: {
      Gstin: inv.seller.gstin,
      LglNm: inv.seller.legalName,
      Addr1: inv.seller.address1,
      Addr2: inv.seller.address2,
      Loc: inv.seller.location,
      Pin: inv.seller.pincode,
      Stcd: inv.seller.stateCode,
    },
    BuyerDtls: {
      Gstin: inv.buyer.gstin,
      LglNm: inv.buyer.legalName,
      Pos: inv.buyer.posStateCode,
      Addr1: inv.buyer.address1,
      Addr2: inv.buyer.address2,
      Loc: inv.buyer.location,
      Pin: inv.buyer.pincode,
      Stcd: inv.buyer.stateCode,
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: r2(inv.taxableAmount),
      CgstVal: r2(inv.split.cgst),
      SgstVal: r2(inv.split.sgst),
      IgstVal: r2(inv.split.igst),
      TotInvVal: r2(inv.totalAmount),
    },
    // Convenience flag for callers/tests; NIC ignores unknown top-level keys.
    _interState: inter,
  };
}

/**
 * Build the NIC e-Way-Bill request from the IRN + transport details. NIC's
 * "Generate EWB by IRN" needs the IRN plus transporter/vehicle/distance and the
 * supply transaction/transport-mode codes.
 */
export function buildEwayRequest(
  irn: string,
  transport: { transporterId?: string; vehicleNo?: string; mode?: string; distanceKm?: number },
): Record<string, unknown> {
  return {
    Irn: irn,
    Distance: Math.max(0, Math.round(transport.distanceKm ?? 0)),
    TransMode: mapTransMode(transport.mode),
    TransId: transport.transporterId,
    VehNo: transport.vehicleNo,
    VehType: 'R', // Regular
  };
}

/** Map a free-text transport mode to NIC's numeric code (1 road default). */
function mapTransMode(mode?: string): string {
  switch ((mode ?? 'road').toLowerCase()) {
    case 'rail': return '2';
    case 'air': return '3';
    case 'ship': return '4';
    default: return '1';
  }
}
