import { DispatchService } from '../src/modules/dispatch/dispatch.service';
import { DispatchRepository } from '../src/modules/dispatch/dispatch.repository';
import { RequestContext } from '../src/common/request-context';
import { Dispatch } from '../src/modules/dispatch/dispatch.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'stores', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function dispatch(over: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: 20, dispatchNo: 'DSP/MUM/2026-27/000020', companyId: 1, buId: 1,
    projectId: 100, customerId: 50, fatId: null, dispatchDate: '2026-06-07',
    shipToAddressId: null, transporter: null, lrNo: null, ewayBillNo: null,
    status: 'DRAFT', qualityClearedBy: null, qualityClearedAt: null,
    commercialClearedBy: null, commercialClearedAt: null,
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    serials: [], packingLines: [], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    setGate: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<DispatchRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('DispatchService', () => {
  let repo: jest.Mocked<DispatchRepository>;
  let service: DispatchService;
  beforeEach(() => { repo = makeRepo(); service = new DispatchService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults DRAFT)', async () => {
      const created = dispatch();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { projectId: 100, customerId: 50 });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ projectId: 100, customerId: 50 }),
        [], [],
      );
    });
    it('maps serials and packing lines into the repo call', async () => {
      repo.create.mockResolvedValue(dispatch());
      await service.create(ctx, {
        projectId: 100, customerId: 50,
        serials: [{ itemId: 7, serialId: 9, qty: 1 }],
        packingLines: [{ packageNo: 'PKG-1', grossWeight: 250 }],
      });
      const [, , serialsArg, packingArg] = repo.create.mock.calls[0];
      expect(serialsArg).toEqual([{ itemId: 7, serialId: 9, qty: 1 }]);
      expect(packingArg).toEqual([{ packageNo: 'PKG-1', grossWeight: 250, dimensions: null }]);
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { projectId: 100, customerId: 50 }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('clearQuality / clearCommercial (the two gates)', () => {
    it('stamps the quality gate on a DRAFT dispatch', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.setGate.mockResolvedValue(dispatch({ qualityClearedBy: 8, rowVersion: 2 }));
      const out = await service.clearQuality(ctx, 20, { rowVersion: 1 });
      expect(out.qualityClearedBy).toBe(8);
      const [, , , patch] = repo.setGate.mock.calls[0];
      expect(patch).toHaveProperty('quality_cleared_by', ctx.userId);
    });
    it('stamps the commercial gate on a DRAFT dispatch', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.setGate.mockResolvedValue(dispatch({ commercialClearedBy: 9, rowVersion: 2 }));
      const out = await service.clearCommercial(ctx, 20, { rowVersion: 1 });
      expect(out.commercialClearedBy).toBe(9);
      const [, , , patch] = repo.setGate.mock.calls[0];
      expect(patch).toHaveProperty('commercial_cleared_by', ctx.userId);
    });
    it('409 when clearing a non-DRAFT dispatch', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'RELEASED' }));
      await expect(code(service.clearQuality(ctx, 20, { rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.setGate).not.toHaveBeenCalled();
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.setGate.mockResolvedValue(null);
      await expect(code(service.clearCommercial(ctx, 20, { rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('release — BOTH gates required', () => {
    it('409 when neither gate is cleared', async () => {
      repo.findById.mockResolvedValue(dispatch());
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when only the quality gate is cleared', async () => {
      repo.findById.mockResolvedValue(dispatch({ qualityClearedBy: 8 }));
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when only the commercial gate is cleared', async () => {
      repo.findById.mockResolvedValue(dispatch({ commercialClearedBy: 9 }));
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when the dispatch is not DRAFT (already released)', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'RELEASED', qualityClearedBy: 8, commercialClearedBy: 9 }));
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
    });
    it('releases once BOTH gates are cleared and emits dispatch.released', async () => {
      repo.findById.mockResolvedValue(dispatch({
        qualityClearedBy: 8, commercialClearedBy: 9,
        serials: [{ dispatchLineId: 1, itemId: 7, serialId: 9, qty: 1 }],
      }));
      repo.updateStatus.mockResolvedValue(dispatch({
        status: 'RELEASED', qualityClearedBy: 8, commercialClearedBy: 9, rowVersion: 2,
      }));
      const out = await service.release(ctx, 20, 1);
      expect(out.status).toBe('RELEASED');
      const eventArg = repo.updateStatus.mock.calls[0][5];
      expect(eventArg).toMatchObject({
        eventType: 'dispatch.released', aggregateType: 'DISPATCH', aggregateId: 20,
      });
      expect((eventArg as { payload: Record<string, unknown> }).payload).toMatchObject({
        projectId: 100, dispatchNo: 'DSP/MUM/2026-27/000020',
      });
    });
    it('409 on a stale row version even with both gates cleared', async () => {
      repo.findById.mockResolvedValue(dispatch({ qualityClearedBy: 8, commercialClearedBy: 9 }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.release(ctx, 20, 1))).resolves.toBe(409);
    });
  });

  describe('lifecycle transitions', () => {
    it('markDelivered: 409 unless RELEASED', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'DRAFT' }));
      await expect(code(service.markDelivered(ctx, 20, 1))).resolves.toBe(409);
    });
    it('markDelivered: RELEASED -> DELIVERED', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'RELEASED' }));
      repo.updateStatus.mockResolvedValue(dispatch({ status: 'DELIVERED', rowVersion: 3 }));
      const out = await service.markDelivered(ctx, 20, 2);
      expect(out.status).toBe('DELIVERED');
    });
    it('cancel: 409 from a terminal state (DELIVERED)', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'DELIVERED' }));
      await expect(code(service.cancel(ctx, 20, { reason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('cancel: DRAFT -> CANCELLED', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.updateStatus.mockResolvedValue(dispatch({ status: 'CANCELLED', rowVersion: 2 }));
      const out = await service.cancel(ctx, 20, { reason: 'customer hold', rowVersion: 1 });
      expect(out.status).toBe('CANCELLED');
    });
  });

  describe('update', () => {
    it('400 when nothing supplied to update', async () => {
      await expect(code(service.update(ctx, 20, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when not DRAFT', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'RELEASED' }));
      await expect(code(service.update(ctx, 20, { rowVersion: 1, transporter: 'BlueDart' }))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 20, { rowVersion: 1, transporter: 'BlueDart' }))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless DRAFT', async () => {
      repo.findById.mockResolvedValue(dispatch({ status: 'RELEASED' }));
      await expect(code(service.delete(ctx, 20))).resolves.toBe(409);
    });
    it('soft-deletes a DRAFT dispatch', async () => {
      repo.findById.mockResolvedValue(dispatch());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 20);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 20);
    });
  });
});
