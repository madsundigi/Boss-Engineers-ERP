import { ProductionService } from '../src/modules/production/production.service';
import { ProductionRepository } from '../src/modules/production/production.repository';
import { RequestContext } from '../src/common/request-context';
import { WorkOrder } from '../src/modules/production/production.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 9, username: 'production', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function wo(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    woId: 10, woNo: 'WO/MUM/2026-27/000010', companyId: 1, buId: 1,
    projectId: 100, wbsId: null, itemId: 200, bomId: null, routingId: null,
    qty: 5, plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null,
    status: 'PLANNED', createdAt: 't', createdBy: 9, updatedAt: 't', rowVersion: 1,
    operations: [{ woOpId: 50, opSeq: 1, workCenterId: 1, stdTimeMin: 60, actualTimeMin: 0, status: 'PENDING' }],
    materials: [], confirmations: [], asBuilt: [], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    confirm: jest.fn(),
    operationBelongsTo: jest.fn(),
    complete: jest.fn(),
  } as unknown as jest.Mocked<ProductionRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ProductionService', () => {
  let repo: jest.Mocked<ProductionRepository>;
  let service: ProductionService;
  beforeEach(() => { repo = makeRepo(); service = new ProductionService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults PLANNED) and emits workorder.created', async () => {
      const created = wo();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { projectId: 100, itemId: 200, qty: 5 });
      expect(out).toBe(created);
      const [, data, event] = repo.create.mock.calls[0];
      expect(data).toMatchObject({ projectId: 100, itemId: 200, qty: 5 });
      expect(event).toMatchObject({ eventType: 'workorder.created', aggregateType: 'WORK_ORDER' });
    });
    it('maps operations + materials onto the repo row', async () => {
      repo.create.mockResolvedValue(wo());
      await service.create(ctx, {
        projectId: 100, itemId: 200, qty: 5,
        operations: [{ opSeq: 1, workCenterId: 7, stdTimeMin: 30 }],
        materials: [{ itemId: 300, requiredQty: 12 }],
      });
      const [, data] = repo.create.mock.calls[0];
      expect(data.operations).toEqual([{ opSeq: 1, workCenterId: 7, stdTimeMin: 30 }]);
      expect(data.materials).toEqual([{ itemId: 300, requiredQty: 12 }]);
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { projectId: 100, itemId: 200, qty: 5 }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('update', () => {
    it('400 when no fields supplied', async () => {
      await expect(code(service.update(ctx, 10, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when the work order is past PLANNED (not editable)', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      await expect(code(service.update(ctx, 10, { rowVersion: 1, qty: 8 }))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(wo());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 10, { rowVersion: 1, qty: 8 }))).resolves.toBe(409);
    });
    it('replaces operations when supplied', async () => {
      repo.findById.mockResolvedValue(wo());
      repo.update.mockResolvedValue(wo({ rowVersion: 2 }));
      await service.update(ctx, 10, { rowVersion: 1, operations: [{ opSeq: 2, workCenterId: 3, stdTimeMin: 10 }] });
      const [, , , , ops] = repo.update.mock.calls[0];
      expect(ops).toEqual([{ opSeq: 2, workCenterId: 3, stdTimeMin: 10 }]);
    });
  });

  describe('release', () => {
    it('409 unless status is PLANNED', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'IN_PROGRESS' }));
      await expect(code(service.release(ctx, 10, { materialReady: true, rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when material is not ready', async () => {
      repo.findById.mockResolvedValue(wo());
      await expect(code(service.release(ctx, 10, { materialReady: false, rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('releases a PLANNED WO and emits workorder.released', async () => {
      repo.findById.mockResolvedValue(wo());
      repo.updateStatus.mockResolvedValue(wo({ status: 'RELEASED', rowVersion: 2 }));
      const out = await service.release(ctx, 10, { materialReady: true, rowVersion: 1 });
      expect(out.status).toBe('RELEASED');
      const eventArg = repo.updateStatus.mock.calls[0][5];
      expect(eventArg).toMatchObject({ eventType: 'workorder.released', aggregateType: 'WORK_ORDER', aggregateId: 10 });
    });
  });

  describe('confirm', () => {
    it('409 when the WO is not in a confirmable state (PLANNED)', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'PLANNED' }));
      await expect(code(service.confirm(ctx, 10, { woOpId: 50, producedQty: 3, scrapQty: 0, reworkQty: 0, actualHours: 2, operationDone: false }))).resolves.toBe(409);
    });
    it('400 when the operation does not belong to the work order', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      await expect(code(service.confirm(ctx, 10, { woOpId: 999, producedQty: 3, scrapQty: 0, reworkQty: 0, actualHours: 2, operationDone: false }))).resolves.toBe(400);
    });
    it('400 when nothing (produced/scrap/rework all zero) is recorded', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      await expect(code(service.confirm(ctx, 10, { woOpId: 50, producedQty: 0, scrapQty: 0, reworkQty: 0, actualHours: 0, operationDone: false }))).resolves.toBe(400);
    });
    it('records a confirmation against a RELEASED WO', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      repo.confirm.mockResolvedValue(wo({ status: 'IN_PROGRESS', rowVersion: 2 }));
      const out = await service.confirm(ctx, 10, { woOpId: 50, producedQty: 3, scrapQty: 1, reworkQty: 0, actualHours: 4, operationDone: true });
      expect(out.status).toBe('IN_PROGRESS');
      expect(repo.confirm).toHaveBeenCalledWith(ctx, 10, 1, {
        woOpId: 50, qtyDone: 3, qtyScrap: 1, qtyRework: 0, labourHours: 4, confDate: undefined, operationDone: true,
      });
    });
  });

  describe('complete', () => {
    it('409 unless status is IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      await expect(code(service.complete(ctx, 10, { rowVersion: 1 }))).resolves.toBe(409);
    });
    it('completes an IN_PROGRESS WO with as-built serials and emits workorder.completed', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'IN_PROGRESS' }));
      repo.complete.mockResolvedValue(wo({ status: 'COMPLETED', rowVersion: 3 }));
      const out = await service.complete(ctx, 10, { rowVersion: 2, asBuilt: [{ serialNo: 'SN-001' }] });
      expect(out.status).toBe('COMPLETED');
      const [, , , itemId, projectId, asBuilt, event] = repo.complete.mock.calls[0];
      expect(itemId).toBe(200);
      expect(projectId).toBe(100);
      expect(asBuilt).toEqual([{ serialNo: 'SN-001', parentSerialNo: undefined }]);
      expect(event).toMatchObject({ eventType: 'workorder.completed', aggregateType: 'WORK_ORDER', aggregateId: 10 });
    });
  });

  describe('changeStatus', () => {
    it('409 when trying to RELEASE via /status (must use /release)', async () => {
      repo.findById.mockResolvedValue(wo());
      await expect(code(service.changeStatus(ctx, 10, { status: 'RELEASED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when trying to COMPLETE via /status (must use /complete)', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'IN_PROGRESS' }));
      await expect(code(service.changeStatus(ctx, 10, { status: 'COMPLETED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 on an illegal transition (PLANNED -> IN_PROGRESS)', async () => {
      repo.findById.mockResolvedValue(wo());
      await expect(code(service.changeStatus(ctx, 10, { status: 'IN_PROGRESS', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('400 when cancelling without a reason', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      await expect(code(service.changeStatus(ctx, 10, { status: 'CANCELLED', rowVersion: 1 }))).resolves.toBe(400);
    });
    it('allows a valid transition (RELEASED -> ON_HOLD)', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      repo.updateStatus.mockResolvedValue(wo({ status: 'ON_HOLD', rowVersion: 2 }));
      const out = await service.changeStatus(ctx, 10, { status: 'ON_HOLD', rowVersion: 1 });
      expect(out.status).toBe('ON_HOLD');
    });
  });
});
