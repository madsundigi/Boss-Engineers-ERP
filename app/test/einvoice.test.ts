import {
  generateKeyPairSync, privateDecrypt, constants as cryptoConstants,
} from 'node:crypto';
import { Pool } from 'pg';
import {
  aesEncrypt, aesDecrypt, decryptSek, generateAppKey, rsaEncrypt, toPublicKeyPem,
} from '../src/services/einvoice/nic.crypto';
import {
  buildInv01, buildEwayRequest, toNicDate, InvoiceForInv01,
} from '../src/services/einvoice/inv01.builder';
import { MockEInvoiceProvider } from '../src/services/einvoice/mock.provider';
import { InvoiceForTax } from '../src/modules/tax/tax.types';

/**
 * Unit tests for the e-invoice provider layer — NO network and NO database.
 * Covers: the AES/RSA crypto envelope (round-trip), the INV-01 payload builder
 * (field mapping + GST split), and the provider factory's mock-vs-NIC choice.
 * The live NIC HTTP flow itself is NOT exercised here — it requires the client's
 * GSP/NIC sandbox credentials and is verified separately against the UAT sandbox.
 */

// A fake Pool; never used by these tests (factory only constructs the provider).
const fakePool = {} as unknown as Pool;

describe('nic.crypto — AES-256-ECB + RSA envelope', () => {
  it('AES encrypt -> decrypt round-trips a UTF-8 payload', () => {
    const key = generateAppKey();
    const plain = JSON.stringify({ UserName: 'u', Password: 'p', n: 42, s: 'naïve €' });
    const enc = aesEncrypt(plain, key);
    expect(enc).not.toContain('UserName');           // actually encrypted
    expect(Buffer.from(enc, 'base64').length).toBeGreaterThan(0);
    expect(aesDecrypt(enc, key)).toBe(plain);
  });

  it('generateAppKey returns 32 bytes (AES-256)', () => {
    expect(generateAppKey()).toHaveLength(32);
  });

  it('rejects a non-32-byte key', () => {
    expect(() => aesEncrypt('x', Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('RSA-encrypts the AppKey so only the private key can recover it', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const appKey = generateAppKey();
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const enc = rsaEncrypt(appKey, pem);
    const recovered = privateDecrypt(
      { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(enc, 'base64'),
    );
    expect(recovered.equals(appKey)).toBe(true);
  });

  it('decryptSek recovers a session key the server AES-wrapped with our AppKey', () => {
    const appKey = generateAppKey();
    const sek = generateAppKey(); // a 32-byte session key
    // Server side: AES-ECB encrypt the Sek with the AppKey, base64.
    const wrapped = aesEncrypt(sek.toString('base64'), appKey);
    // Our decryptSek returns the *base64 string bytes*; decode to compare.
    const recovered = Buffer.from(decryptSek(wrapped, appKey).toString('utf8'), 'base64');
    expect(recovered.equals(sek)).toBe(true);
  });

  it('toPublicKeyPem passes PEM through and wraps bare base64 DER', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----';
    expect(toPublicKeyPem(pem)).toBe(pem);
    const wrapped = toPublicKeyPem('QUJDRA==');
    expect(wrapped.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(wrapped.includes('QUJDRA==')).toBe(true);
  });
});

describe('inv01.builder — INV-01 payload + GST split', () => {
  const base: InvoiceForInv01 = {
    invoiceNo: 'INV/BE/2026/000042',
    invoiceDate: '2026-06-07',
    supplyType: 'INTRA',
    seller: { gstin: '27AAAAA0000A1Z5', legalName: 'Boss Engineers', address1: 'Plot 1',
      location: 'Pune', pincode: 411001, stateCode: '27' },
    buyer: { gstin: '29BBBBB1111B1Z5', legalName: 'Acme', address1: 'MG Rd',
      location: 'Bengaluru', pincode: 560001, stateCode: '29', posStateCode: '29' },
    lines: [{
      slNo: 1, isService: false, hsnCode: '84137010', description: 'Pump',
      qty: 2, unit: 'NOS', unitPrice: 50000, taxableAmount: 100000, gstRatePct: 18,
      cgstAmount: 9000, sgstAmount: 9000, igstAmount: 0,
    }],
    taxableAmount: 100000,
    split: { cgst: 9000, sgst: 9000, igst: 0 },
    totalAmount: 118000,
  };

  it('toNicDate converts YYYY-MM-DD to DD/MM/YYYY', () => {
    expect(toNicDate('2026-06-07')).toBe('07/06/2026');
  });

  it('maps header, parties, items and value block for an INTRA (CGST+SGST) supply', () => {
    const p = buildInv01(base) as any;
    expect(p.Version).toBe('1.1');
    expect(p.DocDtls).toEqual({ Typ: 'INV', No: 'INV/BE/2026/000042', Dt: '07/06/2026' });
    expect(p.SellerDtls.Gstin).toBe('27AAAAA0000A1Z5');
    expect(p.SellerDtls.Stcd).toBe('27');
    expect(p.BuyerDtls.Gstin).toBe('29BBBBB1111B1Z5');
    expect(p.BuyerDtls.Pos).toBe('29');
    // Item mapping + per-item total value (assessable + taxes).
    expect(p.ItemList).toHaveLength(1);
    const it = p.ItemList[0];
    expect(it).toMatchObject({
      SlNo: '1', IsServc: 'N', HsnCd: '84137010', Qty: 2, Unit: 'NOS',
      UnitPrice: 50000, AssAmt: 100000, GstRt: 18, CgstAmt: 9000, SgstAmt: 9000, IgstAmt: 0,
    });
    expect(it.TotItemVal).toBe(118000);
    // Value block: intra-state => CGST+SGST, IGST = 0.
    expect(p.ValDtls).toEqual({
      AssVal: 100000, CgstVal: 9000, SgstVal: 9000, IgstVal: 0, TotInvVal: 118000,
    });
  });

  it('emits IGST (no CGST/SGST) for an INTER-state supply', () => {
    const inter = buildInv01({
      ...base,
      supplyType: 'INTER',
      lines: [{ ...base.lines[0], cgstAmount: 0, sgstAmount: 0, igstAmount: 18000 }],
      split: { cgst: 0, sgst: 0, igst: 18000 },
    }) as any;
    expect(inter.ValDtls).toEqual({
      AssVal: 100000, CgstVal: 0, SgstVal: 0, IgstVal: 18000, TotInvVal: 118000,
    });
    expect(inter.ItemList[0].IgstAmt).toBe(18000);
    expect(inter.ItemList[0].CgstAmt).toBe(0);
    expect(inter._interState).toBe(true);
  });

  it('IsServc=Y flag is set for a service line', () => {
    const p = buildInv01({
      ...base, lines: [{ ...base.lines[0], isService: true, hsnCode: '998314' }],
    }) as any;
    expect(p.ItemList[0].IsServc).toBe('Y');
  });

  it('buildEwayRequest maps transport mode/vehicle/distance to NIC codes', () => {
    const ewb = buildEwayRequest('IRN123', {
      transporterId: '29AAAAA0000A1Z5', vehicleNo: 'KA01AB1234', mode: 'rail', distanceKm: 350.6,
    }) as any;
    expect(ewb).toMatchObject({
      Irn: 'IRN123', Distance: 351, TransMode: '2', TransId: '29AAAAA0000A1Z5', VehNo: 'KA01AB1234',
    });
  });

  it('buildEwayRequest defaults to road (mode 1) and distance 0', () => {
    const ewb = buildEwayRequest('IRN123', {}) as any;
    expect(ewb.TransMode).toBe('1');
    expect(ewb.Distance).toBe(0);
  });
});

describe('MockEInvoiceProvider — deterministic offline artefacts', () => {
  const provider = new MockEInvoiceProvider();
  const inv: InvoiceForTax = {
    invoiceId: 42, companyId: 1, invoiceNo: 'INV/BE/2026/000042', invoiceDate: '2026-06-07',
    taxableAmount: 100000, taxAmount: 18000, totalAmount: 118000, status: 'POSTED',
    irn: null, ackNo: null, ewayBillNo: null,
  };

  it('produces a 64-hex IRN and ACK<padded-id>, deterministically', async () => {
    const a = await provider.generateIrn(inv, { cgst: 9000, sgst: 9000, igst: 0 });
    const b = await provider.generateIrn(inv, { cgst: 9000, sgst: 9000, igst: 0 });
    expect(a.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ackNo).toBe('ACK0000000042');
    expect(a.irn).toBe(b.irn); // deterministic
    expect(a.status).toBe('ACT');
  });

  it('produces a 12-digit e-way bill number once an IRN exists', async () => {
    const out = await provider.generateEwayBill({ ...inv, irn: 'a'.repeat(64) }, {});
    expect(out.ewbNo).toMatch(/^\d{12}$/);
  });
});

describe('getEInvoiceProvider — provider factory', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  /** Re-import the factory with the current process.env (env.ts reads it at load). */
  function loadFactory() {
    let mod!: typeof import('../src/services/einvoice');
    jest.isolateModules(() => { mod = require('../src/services/einvoice'); });
    return mod;
  }

  it('returns the MOCK provider by default (no EINVOICE_PROVIDER set)', () => {
    delete process.env.EINVOICE_PROVIDER;
    const { getEInvoiceProvider, nicConfigured } = loadFactory();
    expect(nicConfigured()).toBe(false);
    expect(getEInvoiceProvider(fakePool).name).toBe('mock');
  });

  it('falls back to MOCK when EINVOICE_PROVIDER=nic but credentials are missing', () => {
    process.env.EINVOICE_PROVIDER = 'nic';
    delete process.env.NIC_BASE_URL;
    delete process.env.NIC_CLIENT_ID;
    const { getEInvoiceProvider, nicConfigured } = loadFactory();
    expect(nicConfigured()).toBe(false);
    expect(getEInvoiceProvider(fakePool).name).toBe('mock');
  });

  it('returns the NIC provider when EINVOICE_PROVIDER=nic AND all creds are present', () => {
    Object.assign(process.env, {
      EINVOICE_PROVIDER: 'nic',
      NIC_BASE_URL: 'https://nic.example.test',
      NIC_CLIENT_ID: 'cid',
      NIC_CLIENT_SECRET: 'secret',
      NIC_USERNAME: 'user',
      NIC_PASSWORD: 'pass',
      NIC_GSTIN: '27AAAAA0000A1Z5',
      NIC_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
    });
    const { getEInvoiceProvider, nicConfigured } = loadFactory();
    expect(nicConfigured()).toBe(true);
    expect(getEInvoiceProvider(fakePool).name).toBe('nic');
  });
});
