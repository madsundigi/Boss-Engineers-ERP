import { SubcontractService } from '../src/modules/subcontract/subcontract.service';
import { SubcontractRepository } from '../src/modules/subcontract/subcontract.repository';
import { RequestContext } from '../src/common/request-context';
import { SubcontractOrder } from '../src/modules/subcontract/subcontract.types';
import { SubcontractStatus, SUBCONTRACT_RECEIVED_EVENT } from '../src/modules/subcontract/subcontract.constants';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 7, username: 'purchase', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function order(over: Partial<SubcontractOrder> = {}): SubcontractOrder {
  return {
    scoId: 30, scoNo: 'SC/MUM/2026-27/000030', companyId: 1, buId: 1,
    vendorId: 50, projectId: 100, scoDate: '2026-06-07', status: 'OPEN',
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1,
    issues: [], receipts: [], ...over,
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
  } as unknown as jest.Mocked<SubcontractRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('SubcontractService', () => {
  let repo: jest.Mocked<SubcontractRepository>;
  let service: SubcontractService;
  beforeEach(() => { repo = makeRepo(); service = new SubcontractService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults OPEN)', async () => {
      const created = order();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { vendorId: 50, projectId: 100 });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx, expect.objectContaining({ vendorId: 50, projectId: 100 }),
      );
    });

    it('400s when no branch (x-bu-id) is in context (numbering needs a branch)', async () => {
      const noBu = { ...ctx, buId: null };
      expect(await code(service.create(noBu, { vendorId: 50 }))).toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('returns the order when found', async () => {
      const o = order();
      repo.findById.mockResolvedValue(o);
      expect(await service.getById(ctx, 30)).toBe(o);
    });
    it('404s when missing', async () => {
      repo.findById.mockResolvedValue(null);
      expect(await code(service.getById(ctx, 999))).toBe(404);
    });
  });

  describe('issueMaterial (OPEN -> ISSUED)', () => {
    it('issues from an OPEN order and inserts issue rows', async () => {
      repo.findById.mockResolvedValue(order({ status: 'OPEN' }));
      const issued = order({ status: 'ISSUED', rowVersion: 2, issues: [{ itemId: 9, qty: 3 }] });
      repo.updateStatus.mockResolvedValue(issued);
      const out = await service.issueMaterial(ctx, 30, { items: [{ itemId: 9, qty: 3 }], rowVersion: 1 });
      expect(out.status).toBe('ISSUED');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        ctx, 30, 1, 'ISSUED', expect.objectContaining({ issues: [{ itemId: 9, qty: 3 }] }),
      );
    });

    it('400s when no item lines are supplied', async () => {
      repo.findById.mockResolvedValue(order({ status: 'OPEN' }));
      expect(await code(service.issueMaterial(ctx, 30, { items: [], rowVersion: 1 }))).toBe(400);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    const blocked: SubcontractStatus[] = ['ISSUED', 'RECEIVED', 'CLOSED', 'CANCELLED'];
    it.each(blocked)('409s issuing from a non-OPEN status (%s)', async (status) => {
      repo.findById.mockResolvedValue(order({ status }));
      expect(await code(service.issueMaterial(ctx, 30, { items: [{ itemId: 9, qty: 3 }], rowVersion: 1 }))).toBe(409);
    });

    it('409s on a stale row version (repo returns null)', async () => {
      repo.findById.mockResolvedValue(order({ status: 'OPEN' }));
      repo.updateStatus.mockResolvedValue(null); // optimistic-lock miss
      expect(await code(service.issueMaterial(ctx, 30, { items: [{ itemId: 9, qty: 3 }], rowVersion: 1 }))).toBe(409);
    });
  });

  describe('receiveGoods (ISSUED -> RECEIVED)', () => {
    it('receives from an ISSUED order and emits subcontract.received', async () => {
      repo.findById.mockResolvedValue(order({ status: 'ISSUED', vendorId: 50, projectId: 100 }));
      const received = order({ status: 'RECEIVED', rowVersion: 3, receipts: [{ itemId: 9, qty: 3 }] });
      repo.updateStatus.mockResolvedValue(received);
      const out = await service.receiveGoods(ctx, 30, { items: [{ itemId: 9, qty: 3 }], rowVersion: 2 });
      expect(out.status).toBe('RECEIVED');
      const callArgs = repo.updateStatus.mock.calls[0];
      expect(callArgs[3]).toBe('RECEIVED');
      const opts = callArgs[4] as { receipts?: unknown; event?: { eventType: string; payload: Record<string, unknown> } };
      expect(opts.receipts).toEqual([{ itemId: 9, qty: 3 }]);
      expect(opts.event?.eventType).toBe(SUBCONTRACT_RECEIVED_EVENT);
      expect(opts.event?.payload).toEqual({ scNo: 'SC/MUM/2026-27/000030', vendorId: 50, projectId: 100 });
    });

    it('400s when no item lines are supplied', async () => {
      repo.findById.mockResolvedValue(order({ status: 'ISSUED' }));
      expect(await code(service.receiveGoods(ctx, 30, { items: [], rowVersion: 2 }))).toBe(400);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('409s receiving from a non-ISSUED status (OPEN)', async () => {
      repo.findById.mockResolvedValue(order({ status: 'OPEN' }));
      expect(await code(service.receiveGoods(ctx, 30, { items: [{ itemId: 9, qty: 3 }], rowVersion: 1 }))).toBe(409);
    });
  });

  describe('close (RECEIVED -> CLOSED)', () => {
    it('closes a RECEIVED order', async () => {
      repo.findById.mockResolvedValue(order({ status: 'RECEIVED' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'CLOSED', rowVersion: 4 }));
      const out = await service.close(ctx, 30, 3);
      expect(out.status).toBe('CLOSED');
      expect(repo.updateStatus).toHaveBeenCalledWith(ctx, 30, 3, 'CLOSED');
    });
    it('409s closing a non-RECEIVED order (ISSUED)', async () => {
      repo.findById.mockResolvedValue(order({ status: 'ISSUED' }));
      expect(await code(service.close(ctx, 30, 2))).toBe(409);
    });
  });

  describe('delete (soft, OPEN only)', () => {
    it('soft-deletes an OPEN order', async () => {
      repo.findById.mockResolvedValue(order({ status: 'OPEN' }));
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
    it('409s deleting a non-OPEN order (ISSUED)', async () => {
      repo.findById.mockResolvedValue(order({ status: 'ISSUED' }));
      expect(await code(service.delete(ctx, 30))).toBe(409);
      expect(repo.softDelete).not.toHaveBeenCalled();
    });
  });
});
