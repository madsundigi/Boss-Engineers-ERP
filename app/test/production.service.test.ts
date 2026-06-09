import { ProductionService, autoSerials } from '../src/modules/production/production.service';
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
    status: 'PLANNED', delayReason: null, percentComplete: null,
    createdAt: 't', createdBy: 9, updatedAt: 't', rowVersion: 1,
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
    it('threads progress metrics (delayReason / percentComplete) through to the header patch', async () => {
      repo.findById.mockResolvedValue(wo());
      repo.update.mockResolvedValue(wo({ delayReason: 'Material shortage', percentComplete: 40, rowVersion: 2 }));
      const out = await service.update(ctx, 10, {
        rowVersion: 1, delayReason: 'Material shortage', percentComplete: 40,
      });
      const [, , , headerFields] = repo.update.mock.calls[0];
      expect(headerFields).toMatchObject({ delayReason: 'Material shortage', percentComplete: 40 });
      expect(out.delayReason).toBe('Material shortage');
      expect(out.percentComplete).toBe(40);
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
    it('honours an explicitly supplied as-built list (serial genealogy)', async () => {
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
    it('auto-creates one serial per produced unit when none supplied (Serial No. Creation)', async () => {
      // qty = 3 finished-goods units, no explicit as-built -> 3 serials derived from wo_no.
      repo.findById.mockResolvedValue(wo({ status: 'IN_PROGRESS', qty: 3, woNo: 'WO/MUM/2026-27/000010' }));
      repo.complete.mockResolvedValue(wo({ status: 'COMPLETED', rowVersion: 3 }));
      await service.complete(ctx, 10, { rowVersion: 2 });
      const [, , , itemId, projectId, asBuilt] = repo.complete.mock.calls[0];
      expect(itemId).toBe(200);
      expect(projectId).toBe(100);
      expect(asBuilt).toEqual([
        { serialNo: 'WO/MUM/2026-27/000010-001' },
        { serialNo: 'WO/MUM/2026-27/000010-002' },
        { serialNo: 'WO/MUM/2026-27/000010-003' },
      ]);
      // serial count is threaded into the completed event payload
      const event = repo.complete.mock.calls[0][6];
      expect(event).toMatchObject({ payload: { serials: 3 } });
    });
    it('floors a fractional qty and treats qty < 1 as a single unit', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'IN_PROGRESS', qty: 0.5, woNo: 'WO/X/1' }));
      repo.complete.mockResolvedValue(wo({ status: 'COMPLETED', rowVersion: 3 }));
      await service.complete(ctx, 10, { rowVersion: 2 });
      const asBuilt = repo.complete.mock.calls[0][5];
      expect(asBuilt).toEqual([{ serialNo: 'WO/X/1-001' }]);
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
    it('captures delayReason / percentComplete in the status patch (e.g. on hold)', async () => {
      repo.findById.mockResolvedValue(wo({ status: 'RELEASED' }));
      repo.updateStatus.mockResolvedValue(wo({
        status: 'ON_HOLD', delayReason: 'Awaiting parts', percentComplete: 25, rowVersion: 2,
      }));
      const out = await service.changeStatus(ctx, 10, {
        status: 'ON_HOLD', rowVersion: 1, delayReason: 'Awaiting parts', percentComplete: 25,
      });
      expect(out.status).toBe('ON_HOLD');
      const patchArg = repo.updateStatus.mock.calls[0][4];
      expect(patchArg).toEqual({ delay_reason: 'Awaiting parts', percent_complete: 25 });
    });
  });

  // "Serial No. Creation" generator — exercised directly for edge cases.
  describe('autoSerials', () => {
    it('generates exactly N serials, 1-based and zero-padded to 3', () => {
      const out = autoSerials('WO/MUM/2026-27/000010', 5);
      expect(out).toHaveLength(5);
      expect(out[0].serialNo).toBe('WO/MUM/2026-27/000010-001');
      expect(out[4].serialNo).toBe('WO/MUM/2026-27/000010-005');
      // unique
      expect(new Set(out.map((s) => s.serialNo)).size).toBe(5);
    });
    it('floors a fractional qty and yields at least one unit for qty < 1', () => {
      expect(autoSerials('WO/X/1', 2.9)).toHaveLength(2);
      expect(autoSerials('WO/X/1', 0.4)).toEqual([{ serialNo: 'WO/X/1-001' }]);
      expect(autoSerials('WO/X/1', 0)).toEqual([{ serialNo: 'WO/X/1-001' }]);
    });
    it('caps the count so a runaway qty cannot explode (≤ 500)', () => {
      expect(autoSerials('WO/X/1', 10_000)).toHaveLength(500);
    });
    it('keeps every serial within scm.serial_number.serial_no (VARCHAR(60))', () => {
      const longWo = 'WO/' + 'A'.repeat(80); // far longer than 60
      const out = autoSerials(longWo, 3);
      expect(out).toHaveLength(3);
      for (const s of out) expect(s.serialNo.length).toBeLessThanOrEqual(60);
      // suffix is preserved (the wo_no prefix is what gets truncated)
      expect(out[2].serialNo.endsWith('-003')).toBe(true);
    });
  });
});
