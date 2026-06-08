/**
 * ============================================================================
 *  NIC IRP (e-Invoice / IRN) + e-Way Bill provider — REAL integration.
 * ----------------------------------------------------------------------------
 *  REQUIRES SANDBOX UAT WITH REAL CREDENTIALS BEFORE PRODUCTION USE.
 *
 *  This provider follows the published NIC e-Invoice (IRP) and e-Way Bill API
 *  specification (hybrid AES-256-ECB + RSA envelope, INV-01 schema v1.1). It is
 *  written to spec but CANNOT be end-to-end verified here because it needs the
 *  taxpayer's GSP/NIC sandbox credentials (client id/secret, username/password,
 *  GSTIN) and NIC's public certificate. Exercise it against the NIC UAT sandbox
 *  and reconcile field-by-field before switching any production traffic to it.
 *
 *  The DEFAULT provider remains the offline mock; this class is selected only
 *  when EINVOICE_PROVIDER=nic AND all required credentials are configured.
 *
 *  No external npm dependency is used — Node 20+ global `fetch` + node:crypto.
 * ============================================================================
 */
import { Pool } from 'pg';
import { runRead } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { Errors } from '../../common/http-error';
import logger from '../../common/logger';
import { InvoiceForTax } from '../../modules/tax/tax.types';
import {
  EInvoiceProvider, EInvoiceResult, EwayResult, EwayTransport, InvoiceGstSplit,
} from './provider';
import {
  aesEncrypt, aesDecrypt, decryptSek, generateAppKey, rsaEncrypt, toPublicKeyPem,
} from './nic.crypto';
import {
  buildInv01, buildEwayRequest, toNicDate,
  InvoiceForInv01, InvoiceLineForInv01, SellerDetails, BuyerDetails,
} from './inv01.builder';

/** Required NIC credentials/config for the real provider. */
export interface NicConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  gstin: string;
  publicKey: string;
  authPath: string;
  irnPath: string;
  cancelIrnPath: string;
  ewayByIrnPath: string;
}

/** A live NIC session: the auth token + the session key (Sek) used to encrypt payloads. */
interface NicSession {
  token: string;
  sek: Buffer;
  expiresAt: number; // epoch ms
}

const FETCH_TIMEOUT_MS = 20_000;

export class NicEInvoiceProvider implements EInvoiceProvider {
  readonly name = 'nic';
  private session: NicSession | null = null;

  constructor(private readonly pool: Pool, private readonly cfg: NicConfig) {}

  // =====================================================================
  // Public provider surface.
  // =====================================================================
  async generateIrn(invoice: InvoiceForTax, split: InvoiceGstSplit): Promise<EInvoiceResult> {
    const session = await this.authenticate();
    const payload = await this.buildInv01Payload(invoice, split);
    const data = await this.callEncrypted(this.cfg.irnPath, payload, session);
    // NIC IRN response (decrypted): { Irn, AckNo, AckDt, SignedInvoice, SignedQRCode, Status }
    const irn = str(data.Irn);
    if (!irn) {
      throw Errors.badGateway('NIC IRP returned no IRN', { response: redact(data) });
    }
    return {
      irn,
      ackNo: str(data.AckNo),
      ackDate: str(data.AckDt) || invoice.invoiceDate,
      signedQrCode: data.SignedQRCode ? String(data.SignedQRCode) : undefined,
      status: str(data.Status) || 'ACT',
    };
  }

  async cancelIrn(irn: string, reason: string): Promise<void> {
    const session = await this.authenticate();
    // NIC cancel payload: Irn + CnlRsn (1=Duplicate,2=Data entry mistake,3=Order cancelled,4=Other) + CnlRem.
    const payload = { Irn: irn, CnlRsn: '2', CnlRem: reason.slice(0, 100) };
    await this.callEncrypted(this.cfg.cancelIrnPath, payload, session);
  }

  async generateEwayBill(invoice: InvoiceForTax, transport: EwayTransport): Promise<EwayResult> {
    if (!invoice.irn) {
      throw Errors.badRequest('Cannot generate an e-way bill: the invoice has no IRN');
    }
    const session = await this.authenticate();
    const payload = buildEwayRequest(invoice.irn, transport);
    const data = await this.callEncrypted(this.cfg.ewayByIrnPath, payload, session);
    // NIC EWB response (decrypted): { EwbNo, EwbDt, EwbValidTill }
    const ewbNo = str(data.EwbNo);
    if (!ewbNo) {
      throw Errors.badGateway('NIC e-Way Bill API returned no EWB number', { response: redact(data) });
    }
    return {
      ewbNo,
      validUpto: data.EwbValidTill ? String(data.EwbValidTill) : undefined,
      status: 'ACT',
    };
  }

  // =====================================================================
  // Authentication — AES/RSA envelope, with token+Sek caching until expiry.
  // =====================================================================
  private async authenticate(): Promise<NicSession> {
    const now = Date.now();
    if (this.session && this.session.expiresAt - 60_000 > now) {
      return this.session; // reuse a live session (60s safety margin)
    }

    const appKey = generateAppKey();
    // The auth request body (before encryption). NIC wants ForceRefreshAccessToken too.
    const authData = {
      UserName: this.cfg.username,
      Password: this.cfg.password,
      AppKey: appKey.toString('base64'),
      ForceRefreshAccessToken: false,
    };
    const body = {
      Data: aesEncrypt(JSON.stringify(authData), appKey),
      // The AppKey, RSA-encrypted with NIC's public certificate.
      appKey: rsaEncrypt(appKey, toPublicKeyPem(this.cfg.publicKey)),
    };

    const res = await this.fetchNic(this.cfg.authPath, body);
    const envelope = await this.readEnvelope(res);
    // Auth response Data (decrypted with the AppKey): { AuthToken, Sek, TokenExpiry }
    const dataB64 = str(envelope.Data);
    if (!dataB64) {
      throw Errors.badGateway('NIC auth returned no Data', { response: redact(envelope) });
    }
    let authResp: Record<string, unknown>;
    try {
      authResp = JSON.parse(aesDecrypt(dataB64, appKey)) as Record<string, unknown>;
    } catch (e) {
      throw Errors.badGateway('Failed to decrypt NIC auth response', { cause: errMsg(e) });
    }
    const token = str(authResp.AuthToken);
    const sekB64 = str(authResp.Sek);
    if (!token || !sekB64) {
      throw Errors.badGateway('NIC auth response missing AuthToken/Sek');
    }
    // The session key (Sek) is itself AES-ECB encrypted with our AppKey.
    const sek = decryptSek(sekB64, appKey);
    const expiry = parseNicExpiry(str(authResp.TokenExpiry));

    this.session = { token, sek, expiresAt: expiry };
    return this.session;
  }

  // =====================================================================
  // Build the INV-01 payload by enriching the invoice (lines + parties).
  // =====================================================================
  private async buildInv01Payload(
    invoice: InvoiceForTax, split: InvoiceGstSplit,
  ): Promise<Record<string, unknown>> {
    const ctx = this.systemCtx(invoice.companyId);
    const enriched = await runRead(this.pool, ctx, async (c) => {
      // Seller = the company. mdm.company has no address table, so derive the
      // state code from the GSTIN (first two digits) and use placeholders for
      // the postal address (NIC requires non-empty Addr1/Loc/Pin).
      const seller = (await c.query(
        `SELECT gstin, legal_name FROM mdm.company WHERE company_id = $1`,
        [invoice.companyId],
      )).rows[0];

      // Buyer = the invoice's customer + its BILL_TO (or BOTH) address.
      const inv = (await c.query(
        `SELECT i.customer_id, cu.gstin AS cust_gstin, cu.customer_name,
                a.line1, a.line2, a.city, a.pincode, a.state_code
           FROM fin.invoice i
           JOIN mdm.customer cu ON cu.customer_id = i.customer_id
           LEFT JOIN mdm.customer_address a
                  ON a.customer_id = cu.customer_id
                 AND a.address_type IN ('BILL_TO','BOTH')
           WHERE i.invoice_id = $1 AND i.company_id = $2
           ORDER BY a.address_id NULLS LAST
           LIMIT 1`,
        [invoice.invoiceId, invoice.companyId],
      )).rows[0];

      // Lines, enriched with HSN/SAC code (mdm.hsn_sac), UQC (mdm.uom) and the
      // combined GST rate from the line's tax_code.
      const lines = (await c.query(
        `SELECT l.invoice_line_id, l.description, l.qty, l.unit_rate,
                l.taxable_amount, l.tax_amount,
                COALESCE(tc.cgst_rate, 0) + COALESCE(tc.sgst_rate, 0)
                  + COALESCE(tc.igst_rate, 0) AS gst_rate,
                hs.hsn_code, u.uom_code,
                CASE WHEN it.item_type = 'SERVICE' THEN true ELSE false END AS is_service
           FROM fin.invoice_line l
           LEFT JOIN mdm.tax_code tc ON tc.tax_code_id = l.tax_code_id
           LEFT JOIN mdm.item it ON it.item_id = l.item_id
           LEFT JOIN mdm.hsn_sac hs ON hs.hsn_id = it.hsn_sac_id
           LEFT JOIN mdm.uom u ON u.uom_id = it.base_uom_id
           WHERE l.invoice_id = $1
           ORDER BY l.invoice_line_id`,
        [invoice.invoiceId],
      )).rows;

      return { seller, inv, lines };
    });

    if (!enriched.seller?.gstin) {
      throw Errors.badRequest('Seller (company) GSTIN is not configured for e-invoicing');
    }
    if (!enriched.inv?.cust_gstin) {
      throw Errors.badRequest('Customer GSTIN is required to raise an e-invoice');
    }

    const inter = split.igst > 0;
    const seller: SellerDetails = {
      gstin: enriched.seller.gstin,
      legalName: enriched.seller.legal_name,
      address1: 'NA', // mdm.company carries no postal address; NIC needs non-empty
      location: 'NA',
      pincode: 999999,
      stateCode: String(enriched.seller.gstin).slice(0, 2),
    };
    const buyerStateCode = String(enriched.inv.state_code ?? enriched.inv.cust_gstin.slice(0, 2));
    const buyer: BuyerDetails = {
      gstin: enriched.inv.cust_gstin,
      legalName: enriched.inv.customer_name,
      address1: enriched.inv.line1 ?? 'NA',
      address2: enriched.inv.line2 ?? undefined,
      location: enriched.inv.city ?? 'NA',
      pincode: toPin(enriched.inv.pincode),
      stateCode: buyerStateCode,
      posStateCode: buyerStateCode,
    };

    // Distribute the header-level GST split across lines proportionally to the
    // line taxable amount (NIC validates Σ line tax ≈ header tax). If the invoice
    // has no lines, synthesise a single line from the header so the schema is valid.
    const rawLines = enriched.lines.length
      ? enriched.lines
      : [{
          description: `Invoice ${invoice.invoiceNo}`,
          qty: 1, unit_rate: invoice.taxableAmount, taxable_amount: invoice.taxableAmount,
          gst_rate: percentOf(split.cgst + split.sgst + split.igst, invoice.taxableAmount),
          hsn_code: null, uom_code: null, is_service: true,
        }];

    const totalTaxable = rawLines.reduce((s: number, l: Record<string, unknown>) => s + Number(l.taxable_amount), 0) || 1;
    const lines: InvoiceLineForInv01[] = rawLines.map((l: Record<string, unknown>, i: number) => {
      const taxable = Number(l.taxable_amount);
      const w = taxable / totalTaxable; // weight of this line in the total
      const isService = l.is_service === true || !l.hsn_code;
      return {
        slNo: i + 1,
        isService,
        // Default to SAC 998314 (IT/technical services) when no HSN/SAC is mapped.
        hsnCode: String(l.hsn_code ?? '998314'),
        description: String(l.description ?? 'NA'),
        qty: Number(l.qty ?? 1),
        unit: String(l.uom_code ?? 'NOS'),
        unitPrice: Number(l.unit_rate ?? taxable),
        taxableAmount: taxable,
        gstRatePct: Number(l.gst_rate ?? 0),
        cgstAmount: inter ? 0 : round2(split.cgst * w),
        sgstAmount: inter ? 0 : round2(split.sgst * w),
        igstAmount: inter ? round2(split.igst * w) : 0,
      };
    });

    const built: InvoiceForInv01 = {
      invoiceNo: invoice.invoiceNo,
      invoiceDate: invoice.invoiceDate,
      supplyType: inter ? 'INTER' : 'INTRA',
      seller,
      buyer,
      lines,
      taxableAmount: invoice.taxableAmount,
      split,
      totalAmount: invoice.totalAmount,
    };
    return buildInv01(built);
  }

  // =====================================================================
  // Low-level transport: encrypt payload with Sek, POST, decrypt response.
  // =====================================================================
  private async callEncrypted(
    path: string, payload: Record<string, unknown>, session: NicSession,
  ): Promise<Record<string, unknown>> {
    const body = { Data: aesEncrypt(JSON.stringify(payload), session.sek) };
    const res = await this.fetchNic(path, body, session.token);
    const envelope = await this.readEnvelope(res);
    const dataB64 = str(envelope.Data);
    if (!dataB64) {
      // Some NIC error envelopes carry no Data; surface ErrorDetails directly.
      throw Errors.badGateway('NIC API returned an empty Data envelope', { response: redact(envelope) });
    }
    try {
      return JSON.parse(aesDecrypt(dataB64, session.sek)) as Record<string, unknown>;
    } catch (e) {
      throw Errors.badGateway('Failed to decrypt NIC API response', { cause: errMsg(e) });
    }
  }

  /** POST JSON to a NIC endpoint with GSP/NIC headers; map transport failures. */
  private async fetchNic(
    path: string, body: unknown, authToken?: string,
  ): Promise<Response> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      gstin: this.cfg.gstin,
    };
    if (authToken) {
      headers['AuthToken'] = authToken;
      headers['user_name'] = this.cfg.username;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      logger.error({ err: errMsg(e), path }, 'NIC request transport error');
      throw Errors.badGateway('Could not reach the NIC e-invoice service', { cause: errMsg(e) });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse the NIC JSON envelope `{ Status, Data, ErrorDetails | InfoDtls }`.
   * On a non-2xx HTTP status or Status !== '1', throw a clear badGateway/badRequest
   * carrying the NIC error code/message.
   */
  private async readEnvelope(res: Response): Promise<Record<string, unknown>> {
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw Errors.badGateway(`NIC returned a non-JSON response (HTTP ${res.status})`, { cause: errMsg(e) });
    }
    // NIC success is Status === '1' (string) or 1 (number).
    const status = json.Status;
    const ok = res.ok && (status === '1' || status === 1);
    if (ok) return json;

    const details = formatNicErrors(json.ErrorDetails ?? json.error ?? json.message);
    logger.warn({ httpStatus: res.status, nicStatus: status, details }, 'NIC API error');
    // 4xx from NIC is typically a validation/data error (caller's fault) -> 400;
    // 5xx / transport-level is a gateway problem -> 502.
    if (res.status >= 400 && res.status < 500) {
      throw Errors.badRequest(`NIC e-invoice rejected the request: ${details}`, { nicStatus: status });
    }
    throw Errors.badGateway(`NIC e-invoice service error: ${details}`, { httpStatus: res.status });
  }

  /**
   * A minimal system RequestContext for the provider's own reads. It carries the
   * invoice's companyId so RLS scoping holds; userId 0 is the system actor.
   */
  private systemCtx(companyId: number): RequestContext {
    return {
      userId: 0, username: 'system:einvoice', companyId, buId: null,
      clientIp: '127.0.0.1', sessionId: 'einvoice', permissions: new Set<string>(),
    };
  }
}

// ----------------------------- helpers --------------------------------
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function percentOf(part: number, whole: number): number {
  return whole ? round2((part / whole) * 100) : 0;
}
function toPin(v: unknown): number {
  const n = Number(String(v ?? '').replace(/\D/g, ''));
  return Number.isFinite(n) && n >= 100000 ? n : 999999;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** Build a readable string from NIC's ErrorDetails array/object. */
function formatNicErrors(err: unknown): string {
  if (!err) return 'unknown error';
  if (Array.isArray(err)) {
    return err
      .map((d) => (d && typeof d === 'object'
        ? `${(d as Record<string, unknown>).ErrorCode ?? ''} ${(d as Record<string, unknown>).ErrorMessage ?? ''}`.trim()
        : String(d)))
      .filter(Boolean)
      .join('; ') || 'unknown error';
  }
  if (typeof err === 'object') return JSON.stringify(err);
  return String(err);
}
/** Drop bulky/sensitive fields before logging a NIC envelope. */
function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const { Data, SignedInvoice, SignedQRCode, ...rest } = obj;
  return rest;
}
/** Parse NIC's 'YYYY-MM-DD HH:mm:ss' TokenExpiry; fall back to +6h on failure. */
function parseNicExpiry(raw: string): number {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (!raw) return Date.now() + SIX_HOURS;
  const t = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(t) ? t : Date.now() + SIX_HOURS;
}

// Re-export so callers/tests can reuse the date formatter alongside the provider.
export { toNicDate };
