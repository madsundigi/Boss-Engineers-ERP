import { Pool, QueryResult, QueryResultRow } from 'pg';
import { ProcurementService } from '../src/modules/procurement/procurement.service';
import { ProcurementRepository, GrnLineInput } from '../src/modules/procurement/procurement.repository';
import { RequestContext } from '../src/common/request-context';
import { PurchaseRequisition, PurchaseOrder, GoodsReceipt } from '../src/modules/procurement/procurement.types';
import { AppError } from '../src/common/http-error';

// A context for an APPROVER (a different user than the document creator) with a bu.
const baseCtx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: 2, username: 'approver', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(), ...over,
});

const samplePr: PurchaseRequisition = {
  prId: 5, prNo: 'PR/MUM/2026/000001', companyId: 1, buId: 1, projectId: null, wbsId: null,
  requiredDate: '2026-07-01', status: 'DRAFT', createdBy: 1, createdAt: 't', rowVersion: 1,
  lines: [{ prLineId: 1, itemId: 7, qty: 10, uomId: 3, requiredDate: '2026-07-01' }],
};

const samplePo: PurchaseOrder = {
  poId: 8, poNo: 'PO/MUM/2026/000001', companyId: 1, buId: 1, vendorId: 4, projectId: null,
  poDate: 't', currencyId: 1, totalAmount: 5000, expectedDate: null, status: 'DRAFT',
  createdBy: 1, createdAt: 't', rowVersion: 1,
  lines: [{ poLineId: 1, itemId: 7, qty: 10, receivedQty: 0, unitRate: 500, lineAmount: 5000, needByDate: null }],
};

const sampleGrn: GoodsReceipt = {
  grnId: 9, grnNo: 'GRN/MUM/2026/000001', companyId: 1, buId: 1, poId: 8, vendorId: 4,
  grnDate: 't', status: 'POSTED', createdBy: 2, createdAt: 't', rowVersion: 1,
  lines: [{ grnLineId: 1, poLineId: 1, itemId: 7, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, warehouseId: 3 }],
};

function makeRepo() {
  return {
    createPr: jest.fn(), findPr: jest.fn(), listPr: jest.fn(), updatePrStatus: jest.fn(),
    vendorIsApproved: jest.fn(), createPo: jest.fn(), findPo: jest.fn(), listPo: jest.fn(), updatePoStatus: jest.fn(),
    findGrn: jest.fn(), listGrn: jest.fn(), receiveGrn: jest.fn(), defaultWarehouseForBu: jest.fn(),
  } as unknown as jest.Mocked<ProcurementRepository>;
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ProcurementService', () => {
  let repo: jest.Mocked<ProcurementRepository>;
  let service: ProcurementService;
  beforeEach(() => { repo = makeRepo(); service = new ProcurementService(repo); });

  // ---- Purchase Requisition ----
  describe('createPr', () => {
    it('400 without a branch (x-bu-id) — required for PR numbering', async () => {
      await expect(status(service.createPr(baseCtx({ buId: null }), {
        lines: [{ itemId: 7, qty: 1 }],
      }))).resolves.toBe(400);
      expect(repo.createPr).not.toHaveBeenCalled();
    });

    it('delegates to the repository with a bu set', async () => {
      repo.createPr.mockResolvedValue(samplePr);
      const out = await service.createPr(baseCtx(), { lines: [{ itemId: 7, qty: 10 }] });
      expect(out).toBe(samplePr);
      expect(repo.createPr).toHaveBeenCalled();
    });
  });

  describe('approvePr (DOA + SoD + transitions)', () => {
    it('403 when the approver created the PR (Segregation of Duties)', async () => {
      repo.findPr.mockResolvedValue({ ...samplePr, status: 'PENDING', createdBy: 2 });
      await expect(status(service.approvePr(baseCtx({ userId: 2 }), 5, 1))).resolves.toBe(403);
      expect(repo.updatePrStatus).not.toHaveBeenCalled();
    });

    it('409 unless the PR is PENDING', async () => {
      repo.findPr.mockResolvedValue({ ...samplePr, status: 'DRAFT' });
      await expect(status(service.approvePr(baseCtx(), 5, 1))).resolves.toBe(409);
      expect(repo.updatePrStatus).not.toHaveBeenCalled();
    });

    it('approves a PENDING PR raised by someone else', async () => {
      repo.findPr.mockResolvedValue({ ...samplePr, status: 'PENDING', createdBy: 1 });
      repo.updatePrStatus.mockResolvedValue({ ...samplePr, status: 'APPROVED', rowVersion: 2 });
      const out = await service.approvePr(baseCtx({ userId: 2 }), 5, 1);
      expect(out.status).toBe('APPROVED');
      expect(repo.updatePrStatus).toHaveBeenCalledWith(baseCtx({ userId: 2 }), 5, 1, 'APPROVED');
    });

    it('409 on row-version mismatch (optimistic concurrency)', async () => {
      repo.findPr.mockResolvedValue({ ...samplePr, status: 'PENDING', createdBy: 1 });
      repo.updatePrStatus.mockResolvedValue(null);
      await expect(status(service.approvePr(baseCtx(), 5, 1))).resolves.toBe(409);
    });
  });

  describe('submitPr', () => {
    it('409 unless the PR is DRAFT', async () => {
      repo.findPr.mockResolvedValue({ ...samplePr, status: 'APPROVED' });
      await expect(status(service.submitPr(baseCtx(), 5, 1))).resolves.toBe(409);
    });
  });

  // ---- Purchase Order ----
  describe('createPo (vendor-approval gate)', () => {
    it('409 when the vendor is not approved', async () => {
      repo.vendorIsApproved.mockResolvedValue(false);
      await expect(status(service.createPo(baseCtx(), {
        vendorId: 4, lines: [{ itemId: 7, qty: 10, unitRate: 500 }],
      }))).resolves.toBe(409);
      expect(repo.createPo).not.toHaveBeenCalled();
    });

    it('404 when the vendor does not exist', async () => {
      repo.vendorIsApproved.mockResolvedValue(null);
      await expect(status(service.createPo(baseCtx(), {
        vendorId: 999, lines: [{ itemId: 7, qty: 10, unitRate: 500 }],
      }))).resolves.toBe(404);
    });

    it('400 without a branch (x-bu-id)', async () => {
      await expect(status(service.createPo(baseCtx({ buId: null }), {
        vendorId: 4, lines: [{ itemId: 7, qty: 10, unitRate: 500 }],
      }))).resolves.toBe(400);
    });

    it('creates a PO on an approved vendor', async () => {
      repo.vendorIsApproved.mockResolvedValue(true);
      repo.createPo.mockResolvedValue(samplePo);
      const out = await service.createPo(baseCtx(), { vendorId: 4, lines: [{ itemId: 7, qty: 10, unitRate: 500 }] });
      expect(out).toBe(samplePo);
      expect(repo.createPo).toHaveBeenCalled();
    });
  });

  describe('approvePo (DOA + committed cost + outbox)', () => {
    it('403 when the approver created the PO (Segregation of Duties)', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'PENDING', createdBy: 2 });
      await expect(status(service.approvePo(baseCtx({ userId: 2 }), 8, 1))).resolves.toBe(403);
      expect(repo.updatePoStatus).not.toHaveBeenCalled();
    });

    it('409 unless the PO is DRAFT/PENDING', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'APPROVED' });
      await expect(status(service.approvePo(baseCtx(), 8, 1))).resolves.toBe(409);
    });

    it('approves a PO and emits po.approved with the committed cost', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'PENDING', createdBy: 1 });
      repo.updatePoStatus.mockResolvedValue({ ...samplePo, status: 'APPROVED', rowVersion: 2 });
      const out = await service.approvePo(baseCtx({ userId: 2 }), 8, 1);
      expect(out.purchaseOrder.status).toBe('APPROVED');
      expect(out.committedCost).toBe(5000);
      // the outbox event is passed to the repository in the same call
      const evt = repo.updatePoStatus.mock.calls[0][4];
      expect(evt).toMatchObject({ eventType: 'po.approved', aggregateType: 'PURCHASE_ORDER', aggregateId: 8 });
    });

    it('409 on row-version mismatch', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'PENDING', createdBy: 1 });
      repo.updatePoStatus.mockResolvedValue(null);
      await expect(status(service.approvePo(baseCtx(), 8, 1))).resolves.toBe(409);
    });
  });

  // ---- Goods Receipt ----
  describe('receiveGrn', () => {
    it('409 unless the PO is APPROVED/PARTIAL', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'DRAFT' });
      await expect(status(service.receiveGrn(baseCtx(), {
        poId: 8, lines: [{ itemId: 7, receivedQty: 10 }],
      }))).resolves.toBe(409);
      expect(repo.receiveGrn).not.toHaveBeenCalled();
    });

    it('400 when no warehouse can be resolved for the branch', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'APPROVED' });
      repo.defaultWarehouseForBu.mockResolvedValue(null);
      await expect(status(service.receiveGrn(baseCtx(), {
        poId: 8, lines: [{ itemId: 7, receivedQty: 10 }],
      }))).resolves.toBe(400);
    });

    it('receives against an APPROVED PO, tying the GRN to the PO vendor', async () => {
      repo.findPo.mockResolvedValue({ ...samplePo, status: 'APPROVED' });
      repo.defaultWarehouseForBu.mockResolvedValue(3);
      repo.receiveGrn.mockResolvedValue(sampleGrn);
      const out = await service.receiveGrn(baseCtx(), { poId: 8, lines: [{ poLineId: 1, itemId: 7, receivedQty: 10 }] });
      expect(out).toBe(sampleGrn);
      // vendorId (4) + warehouse (3) are passed through from the PO / default lookup
      expect(repo.receiveGrn).toHaveBeenCalledWith(expect.anything(), 8, 4, 3, expect.any(Array));
    });
  });
});

// ---------------------------------------------------------------------------
// Repository: GRN -> Inventory stock posting (Procurement feeds Inventory).
// Driven through a fake pg Pool/Client (no DB) so we can assert the exact
// scm.stock_transaction INSERT receiveGrn issues in-transaction. The api test
// (procurement.api.test.ts) covers the same path end-to-end against Postgres.
// ---------------------------------------------------------------------------

interface CapturedQuery { text: string; params: unknown[]; }

/**
 * A fake Pool whose connect() yields a client that records every query and
 * answers from `responder`. runInContext drives BEGIN/SET/COMMIT through it too.
 */
function fakePool(responder: (text: string, params: unknown[]) => QueryResultRow[]): {
  pool: Pool; queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const query = async <T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    queries.push({ text, params });
    const rows = responder(text, params) as T[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  };
  const client = { query, release: () => undefined };
  const pool = { connect: async () => client, query } as unknown as Pool;
  return { pool, queries };
}

describe('ProcurementRepository.receiveGrn -> stock_transaction posting', () => {
  const ctx = baseCtx();
  const GRN_ID = 9;
  const PO_ID = 8;
  const WAREHOUSE_ID = 3;

  // A responder that reflects the schema: GRN insert returns a header row;
  // the idempotency probe finds nothing; the PO carries project 55; the PO line
  // is priced at 500. Everything else (grn_line / po_line / stock_transaction
  // INSERTs, fetchGrnLines) returns no rows.
  const responder = (text: string): QueryResultRow[] => {
    if (/INSERT INTO scm\.goods_receipt/i.test(text)) {
      return [{
        grn_id: GRN_ID, grn_no: 'GRN/MUM/2026/000001', company_id: ctx.companyId, bu_id: ctx.buId,
        po_id: PO_ID, vendor_id: 4, grn_date: 't', status: 'POSTED', created_by: ctx.userId,
        created_at: 't', row_version: 1,
      }];
    }
    if (/FROM scm\.stock_transaction/i.test(text)) return []; // idempotency probe: none yet
    if (/SELECT project_id FROM scm\.purchase_order/i.test(text)) return [{ project_id: 55 }];
    if (/SELECT unit_rate FROM scm\.po_line/i.test(text)) return [{ unit_rate: '500' }];
    return [];
  };

  const lines: GrnLineInput[] = [{ poLineId: 1, itemId: 7, receivedQty: 10, acceptedQty: 10, rejectedQty: 0 }];

  it('appends one positive GRN stock_transaction per received line (qty, ref, cost, project)', async () => {
    const { pool, queries } = fakePool(responder);
    const repo = new ProcurementRepository(pool);

    await repo.receiveGrn(ctx, PO_ID, 4, WAREHOUSE_ID, lines);

    const posts = queries.filter((q) => /INSERT INTO scm\.stock_transaction/i.test(q.text));
    expect(posts).toHaveLength(1);
    const p = posts[0].params;
    // VALUES ($1 company, $2 item, $3 warehouse, 'GRN', $4 qty, $5 cost, $6 project, 'GRN', $7 ref, $8 by)
    expect(p[0]).toBe(ctx.companyId);   // company_id
    expect(p[1]).toBe(7);               // item_id
    expect(p[2]).toBe(WAREHOUSE_ID);    // warehouse_id
    expect(p[3]).toBe(10);              // qty — positive received qty
    expect(p[4]).toBe(500);             // unit_cost — from the PO line
    expect(p[5]).toBe(55);              // project_id — from the parent PO
    expect(p[6]).toBe(GRN_ID);          // ref_doc_id — the GRN
    expect(p[7]).toBe(ctx.userId);      // created_by
    // txn_type 'GRN' + ref_doc_type 'GRN' are literals in the statement.
    expect(posts[0].text).toMatch(/'GRN'/);
  });

  it('uses unit_cost 0 and project NULL for an unmatched receipt (no poLineId, no PO project)', async () => {
    const noProject = (text: string): QueryResultRow[] =>
      /SELECT project_id FROM scm\.purchase_order/i.test(text) ? [{ project_id: null }] : responder(text);
    const { pool, queries } = fakePool(noProject);
    const repo = new ProcurementRepository(pool);

    await repo.receiveGrn(ctx, PO_ID, 4, WAREHOUSE_ID, [{ itemId: 7, receivedQty: 4 }]);

    const post = queries.find((q) => /INSERT INTO scm\.stock_transaction/i.test(q.text))!;
    expect(post.params[3]).toBe(4);     // qty
    expect(post.params[4]).toBe(0);     // unit_cost defaults to 0 (no PO line)
    expect(post.params[5]).toBeNull();  // project_id NULL (PO not project-bound)
    // an unmatched line must NOT look up a po_line rate
    expect(queries.some((q) => /SELECT unit_rate FROM scm\.po_line/i.test(q.text))).toBe(false);
  });

  it('is idempotent: skips posting when a GRN stock_transaction already exists', async () => {
    const existing = (text: string): QueryResultRow[] =>
      /FROM scm\.stock_transaction/i.test(text) ? [{ exists: 1 }] : responder(text);
    const { pool, queries } = fakePool(existing);
    const repo = new ProcurementRepository(pool);

    await repo.receiveGrn(ctx, PO_ID, 4, WAREHOUSE_ID, lines);

    expect(queries.some((q) => /INSERT INTO scm\.stock_transaction/i.test(q.text))).toBe(false);
  });
});
