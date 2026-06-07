import { InventoryService } from '../src/modules/inventory/inventory.service';
import { InventoryRepository } from '../src/modules/inventory/inventory.repository';
import { RequestContext } from '../src/common/request-context';
import { StockAdjustment, MaterialIssue, Reservation } from '../src/modules/inventory/inventory.types';
import { INVENTORY_PERMS } from '../src/modules/inventory/inventory.constants';
import { AppError } from '../src/common/http-error';

const baseCtx = (perms: string[] = []): RequestContext => ({
  userId: 1, username: 'tester', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(perms),
});

const sampleAdj: StockAdjustment = {
  adjId: 5, companyId: 1, itemId: 7, warehouseId: 3, projectId: null,
  adjType: 'RECEIPT', qty: 10, unitCost: 100, reason: null, status: 'DRAFT',
  approvedBy: null, approvedAt: null, createdAt: 't', createdBy: 1, rowVersion: 1,
};

const sampleIssue: MaterialIssue = {
  issueId: 9, companyId: 1, issueNo: 'MI-000001', projectId: 2, woId: null,
  itemId: 7, qty: 4, warehouseId: 3, unitCost: 100, issueDate: 't', createdAt: 't',
};

const sampleResv: Reservation = {
  reservationId: 11, projectId: 2, wbsId: null, itemId: 7, qty: 4,
  warehouseId: 3, status: 'OPEN', reservedAt: 't',
};

function makeRepo() {
  return {
    listStock: jest.fn(),
    availableFor: jest.fn(),
    createAdjustment: jest.fn(),
    findAdjustment: jest.fn(),
    listAdjustments: jest.fn(),
    approveAndPostAdjustment: jest.fn(),
    rejectAdjustment: jest.fn(),
    reserve: jest.fn(),
    issue: jest.fn(),
    listCritical: jest.fn(),
  } as unknown as jest.Mocked<InventoryRepository>;
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('InventoryService', () => {
  let repo: jest.Mocked<InventoryRepository>;
  let service: InventoryService;
  beforeEach(() => { repo = makeRepo(); service = new InventoryService(repo); });

  describe('createAdjustment', () => {
    it('delegates to the repository', async () => {
      repo.createAdjustment.mockResolvedValue(sampleAdj);
      const out = await service.createAdjustment(baseCtx(), {
        itemId: 7, warehouseId: 3, adjType: 'RECEIPT', qty: 10, unitCost: 100,
      });
      expect(out).toBe(sampleAdj);
      expect(repo.createAdjustment).toHaveBeenCalled();
    });
  });

  describe('getAdjustment', () => {
    it('404 when not found', async () => {
      repo.findAdjustment.mockResolvedValue(null);
      await expect(status(service.getAdjustment(baseCtx(), 99))).resolves.toBe(404);
    });
  });

  describe('approveAdjustment', () => {
    it('409 unless current status is DRAFT', async () => {
      repo.findAdjustment.mockResolvedValue({ ...sampleAdj, status: 'POSTED' });
      await expect(status(service.approveAdjustment(baseCtx([INVENTORY_PERMS.APPROVE]), 5, 1))).resolves.toBe(409);
      expect(repo.approveAndPostAdjustment).not.toHaveBeenCalled();
    });

    it('403 when approving a WRITE_OFF without INVENTORY.APPROVE', async () => {
      repo.findAdjustment.mockResolvedValue({ ...sampleAdj, adjType: 'WRITE_OFF' });
      // caller holds only EDIT, not APPROVE
      await expect(status(service.approveAdjustment(baseCtx([INVENTORY_PERMS.EDIT]), 5, 1))).resolves.toBe(403);
      expect(repo.approveAndPostAdjustment).not.toHaveBeenCalled();
    });

    it('posts a WRITE_OFF when the caller holds INVENTORY.APPROVE', async () => {
      const ctx = baseCtx([INVENTORY_PERMS.APPROVE]);
      repo.findAdjustment.mockResolvedValue({ ...sampleAdj, adjType: 'WRITE_OFF' });
      repo.approveAndPostAdjustment.mockResolvedValue({ ...sampleAdj, adjType: 'WRITE_OFF', status: 'POSTED', rowVersion: 2 });
      const out = await service.approveAdjustment(ctx, 5, 1);
      expect(out.status).toBe('POSTED');
      expect(repo.approveAndPostAdjustment).toHaveBeenCalledWith(ctx, 5, 1);
    });

    it('409 on row-version mismatch (optimistic concurrency)', async () => {
      repo.findAdjustment.mockResolvedValue(sampleAdj);
      repo.approveAndPostAdjustment.mockResolvedValue(null);
      await expect(status(service.approveAdjustment(baseCtx([INVENTORY_PERMS.APPROVE]), 5, 1))).resolves.toBe(409);
    });

    it('posts a RECEIPT (no write-off) successfully', async () => {
      repo.findAdjustment.mockResolvedValue(sampleAdj);
      repo.approveAndPostAdjustment.mockResolvedValue({ ...sampleAdj, status: 'POSTED', rowVersion: 2 });
      const out = await service.approveAdjustment(baseCtx([INVENTORY_PERMS.APPROVE]), 5, 1);
      expect(out.status).toBe('POSTED');
    });
  });

  describe('reserve', () => {
    it('409 when available stock is insufficient', async () => {
      repo.reserve.mockResolvedValue({ result: { ok: false, available: 2 } });
      await expect(status(service.reserve(baseCtx(), {
        projectId: 2, itemId: 7, warehouseId: 3, qty: 5,
      }))).resolves.toBe(409);
    });

    it('reserves when stock is available', async () => {
      repo.reserve.mockResolvedValue({ result: { ok: true, available: 0 }, reservation: sampleResv });
      const out = await service.reserve(baseCtx(), { projectId: 2, itemId: 7, warehouseId: 3, qty: 4 });
      expect(out).toBe(sampleResv);
    });
  });

  describe('issue (over-issue guard)', () => {
    it('409 when issuing more than on hand', async () => {
      repo.issue.mockResolvedValue({ result: { ok: false, available: 3 } });
      const code = await status(service.issue(baseCtx(), {
        projectId: 2, itemId: 7, warehouseId: 3, qty: 10, unitCost: 0,
      }));
      expect(code).toBe(409);
    });

    it('issues when enough stock is on hand', async () => {
      repo.issue.mockResolvedValue({ result: { ok: true, available: 0 }, issue: sampleIssue });
      const out = await service.issue(baseCtx(), { projectId: 2, itemId: 7, warehouseId: 3, qty: 4, unitCost: 100 });
      expect(out).toBe(sampleIssue);
      expect(out.issueNo).toBe('MI-000001');
    });
  });

  describe('exportStockCsv', () => {
    it('emits a header row even with no stock', async () => {
      repo.listStock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 200 });
      const csv = await service.exportStockCsv(baseCtx(), {
        page: 1, pageSize: 25, sort: 'item_code', dir: 'asc', onlyAvailable: false,
      });
      expect(csv.split('\n')[0]).toContain('Item Code');
    });
  });
});
