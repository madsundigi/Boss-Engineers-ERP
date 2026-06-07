import { ChangeOrderService } from '../src/modules/change/change.service';
import { ChangeOrderRepository } from '../src/modules/change/change.repository';
import { RequestContext } from '../src/common/request-context';
import { ChangeOrder } from '../src/modules/change/change.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'planner', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function changeOrder(over: Partial<ChangeOrder> = {}): ChangeOrder {
  return {
    changeOrderId: 30, changeNo: 'CO/MUM/2026-27/000030', companyId: 1, buId: 1,
    projectId: 100, description: 'Add stainless cladding', reason: null,
    costImpact: 50000, priceImpact: 65000, scheduleImpactDays: 7,
    status: 'DRAFT', createdAt: 't', createdBy: 5, updatedAt: 't', updatedBy: null,
    rowVersion: 1, ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<ChangeOrderRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ChangeOrderService', () => {
  let repo: jest.Mocked<ChangeOrderRepository>;
  let service: ChangeOrderService;
  beforeEach(() => { repo = makeRepo(); service = new ChangeOrderService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults DRAFT)', async () => {
      const created = changeOrder();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, {
        projectId: 100, description: 'Add stainless cladding',
        costImpact: 50000, priceImpact: 65000, scheduleImpactDays: 7,
      });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ projectId: 100, costImpact: 50000, priceImpact: 65000 }),
      );
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create(
        { ...ctx, buId: null },
        { projectId: 100, description: 'x', costImpact: 0, priceImpact: 0, scheduleImpactDays: 0 },
      ))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('update (DRAFT only)', () => {
    it('400 when nothing supplied to update', async () => {
      await expect(code(service.update(ctx, 30, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when not DRAFT', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED' }));
      await expect(code(service.update(ctx, 30, { rowVersion: 1, costImpact: 9 }))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(changeOrder());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 30, { rowVersion: 1, costImpact: 9 }))).resolves.toBe(409);
    });
  });

  describe('submit', () => {
    it('DRAFT -> SUBMITTED', async () => {
      repo.findById.mockResolvedValue(changeOrder());
      repo.updateStatus.mockResolvedValue(changeOrder({ status: 'SUBMITTED', rowVersion: 2 }));
      const out = await service.submit(ctx, 30, 1);
      expect(out.status).toBe('SUBMITTED');
    });
    it('409 unless DRAFT', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'APPROVED' }));
      await expect(code(service.submit(ctx, 30, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('approve — SoD + outbox', () => {
    it('403 when the approver is the creator (Segregation of Duties)', async () => {
      // createdBy === ctx.userId (5)
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED', createdBy: 5 }));
      await expect(code(service.approve(ctx, 30, 1))).resolves.toBe(403);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 unless SUBMITTED', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'DRAFT', createdBy: 9 }));
      await expect(code(service.approve(ctx, 30, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('SUBMITTED -> APPROVED by a different user and emits change_order.approved', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED', createdBy: 9 }));
      repo.updateStatus.mockResolvedValue(changeOrder({ status: 'APPROVED', createdBy: 9, rowVersion: 2 }));
      const out = await service.approve(ctx, 30, 1);
      expect(out.status).toBe('APPROVED');
      const eventArg = repo.updateStatus.mock.calls[0][5];
      expect(eventArg).toMatchObject({
        eventType: 'change_order.approved', aggregateType: 'CHANGE_ORDER', aggregateId: 30,
      });
      expect((eventArg as { payload: Record<string, unknown> }).payload).toMatchObject({
        changeNo: 'CO/MUM/2026-27/000030', projectId: 100, costImpact: 50000, priceImpact: 65000,
      });
    });
    it('409 on a stale row version even when SoD passes', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED', createdBy: 9 }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.approve(ctx, 30, 1))).resolves.toBe(409);
    });
  });

  describe('reject', () => {
    it('SUBMITTED -> REJECTED carrying the reason', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED' }));
      repo.updateStatus.mockResolvedValue(changeOrder({ status: 'REJECTED', rowVersion: 2 }));
      const out = await service.reject(ctx, 30, { reason: 'out of scope', rowVersion: 1 });
      expect(out.status).toBe('REJECTED');
      const [, , , status, patch] = repo.updateStatus.mock.calls[0];
      expect(status).toBe('REJECTED');
      expect(patch).toMatchObject({ reason: 'out of scope' });
    });
    it('409 unless SUBMITTED', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'APPROVED' }));
      await expect(code(service.reject(ctx, 30, { reason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('markImplemented', () => {
    it('APPROVED -> IMPLEMENTED', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'APPROVED' }));
      repo.updateStatus.mockResolvedValue(changeOrder({ status: 'IMPLEMENTED', rowVersion: 3 }));
      const out = await service.markImplemented(ctx, 30, 2);
      expect(out.status).toBe('IMPLEMENTED');
    });
    it('409 unless APPROVED', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED' }));
      await expect(code(service.markImplemented(ctx, 30, 1))).resolves.toBe(409);
    });
  });

  describe('cancel', () => {
    it('DRAFT -> CANCELLED', async () => {
      repo.findById.mockResolvedValue(changeOrder());
      repo.updateStatus.mockResolvedValue(changeOrder({ status: 'CANCELLED', rowVersion: 2 }));
      const out = await service.cancel(ctx, 30, 1);
      expect(out.status).toBe('CANCELLED');
    });
    it('409 from a terminal state (IMPLEMENTED)', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'IMPLEMENTED' }));
      await expect(code(service.cancel(ctx, 30, 1))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless DRAFT', async () => {
      repo.findById.mockResolvedValue(changeOrder({ status: 'SUBMITTED' }));
      await expect(code(service.delete(ctx, 30))).resolves.toBe(409);
    });
    it('soft-deletes a DRAFT change order', async () => {
      repo.findById.mockResolvedValue(changeOrder());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
  });
});
