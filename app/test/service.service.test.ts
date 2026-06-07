import { ServiceService } from '../src/modules/service/service.service';
import { ServiceRepository } from '../src/modules/service/service.repository';
import { RequestContext } from '../src/common/request-context';
import { ServiceTicket, WarrantyClaim } from '../src/modules/service/service.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 5, username: 'service', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function ticket(over: Partial<ServiceTicket> = {}): ServiceTicket {
  return {
    ticketId: 30, ticketNo: 'TKT/MUM/2026-27/000030', companyId: 1, buId: 1,
    customerId: 50, serialId: null, warrantyId: null, contractId: null,
    priority: 'MED', isInWarranty: false, reportedAt: 't', slaDueAt: null,
    resolution: null, status: 'OPEN', assignedEngineerId: null,
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    visits: [], spares: [], ...over,
  };
}

function claim(over: Partial<WarrantyClaim> = {}): WarrantyClaim {
  return {
    claimId: 7, warrantyId: 11, ticketId: 30, claimDate: '2026-06-07',
    claimCost: 0, status: 'APPROVED', approvedBy: 5, ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    assign: jest.fn(),
    recordWarrantyClaim: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<ServiceRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ServiceService', () => {
  let repo: jest.Mocked<ServiceRepository>;
  let service: ServiceService;
  beforeEach(() => { repo = makeRepo(); service = new ServiceService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults OPEN)', async () => {
      const created = ticket();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { customerId: 50 });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ customerId: 50 }),
        [], [],
      );
    });
    it('maps visits and spares into the repo call', async () => {
      repo.create.mockResolvedValue(ticket());
      await service.create(ctx, {
        customerId: 50,
        visits: [{ engineerId: 3, hours: 2, travelCost: 150 }],
        spares: [{ itemId: 7, qty: 1, unitCost: 99, isChargeable: true }],
      });
      const [, , visitsArg, sparesArg] = repo.create.mock.calls[0];
      expect(visitsArg).toEqual([
        expect.objectContaining({ engineerId: 3, hours: 2, travelCost: 150 }),
      ]);
      expect(sparesArg).toEqual([{ itemId: 7, qty: 1, unitCost: 99, isChargeable: true }]);
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { customerId: 50 }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('assign', () => {
    it('stamps the engineer (OPEN -> ASSIGNED)', async () => {
      repo.findById.mockResolvedValue(ticket());
      repo.assign.mockResolvedValue(ticket({ status: 'ASSIGNED', assignedEngineerId: 3, rowVersion: 2 }));
      const out = await service.assign(ctx, 30, { engineerId: 3, rowVersion: 1 });
      expect(out.assignedEngineerId).toBe(3);
      expect(repo.assign).toHaveBeenCalledWith(ctx, 30, 1, 3);
    });
    it('409 when assigning a terminal (CLOSED) ticket', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CLOSED' }));
      await expect(code(service.assign(ctx, 30, { engineerId: 3, rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.assign).not.toHaveBeenCalled();
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(ticket());
      repo.assign.mockResolvedValue(null);
      await expect(code(service.assign(ctx, 30, { engineerId: 3, rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('lifecycle transitions', () => {
    it('startWork: OPEN -> IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'OPEN' }));
      repo.updateStatus.mockResolvedValue(ticket({ status: 'IN_PROGRESS', rowVersion: 2 }));
      const out = await service.startWork(ctx, 30, 1);
      expect(out.status).toBe('IN_PROGRESS');
    });
    it('startWork: 409 from a terminal state (CANCELLED)', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CANCELLED' }));
      await expect(code(service.startWork(ctx, 30, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('close: 409 unless RESOLVED', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'IN_PROGRESS' }));
      await expect(code(service.close(ctx, 30, 1))).resolves.toBe(409);
    });
    it('close: RESOLVED -> CLOSED', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'RESOLVED' }));
      repo.updateStatus.mockResolvedValue(ticket({ status: 'CLOSED', rowVersion: 3 }));
      const out = await service.close(ctx, 30, 2);
      expect(out.status).toBe('CLOSED');
    });
    it('cancel: 409 from a terminal state (CLOSED)', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CLOSED' }));
      await expect(code(service.cancel(ctx, 30, { reason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('cancel: OPEN -> CANCELLED', async () => {
      repo.findById.mockResolvedValue(ticket());
      repo.updateStatus.mockResolvedValue(ticket({ status: 'CANCELLED', rowVersion: 2 }));
      const out = await service.cancel(ctx, 30, { reason: 'duplicate', rowVersion: 1 });
      expect(out.status).toBe('CANCELLED');
    });
  });

  describe('resolve — emits service_ticket.resolved', () => {
    it('409 when the ticket cannot be resolved (CLOSED)', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CLOSED' }));
      await expect(code(service.resolve(ctx, 30, { resolution: 'fixed', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('resolves an IN_PROGRESS ticket and emits the event with the resolution patch', async () => {
      repo.findById.mockResolvedValue(ticket({
        status: 'IN_PROGRESS', isInWarranty: true,
        spares: [{ spareIssueId: 1, itemId: 7, qty: 2, unitCost: 50, isChargeable: false }],
      }));
      repo.updateStatus.mockResolvedValue(ticket({ status: 'RESOLVED', resolution: 'replaced seal', rowVersion: 2 }));
      const out = await service.resolve(ctx, 30, { resolution: 'replaced seal', rowVersion: 1 });
      expect(out.status).toBe('RESOLVED');
      const [, , , status, patch, event] = repo.updateStatus.mock.calls[0];
      expect(status).toBe('RESOLVED');
      expect(patch).toMatchObject({ resolution: 'replaced seal' });
      expect(event).toMatchObject({
        eventType: 'service_ticket.resolved', aggregateType: 'SERVICE_TICKET', aggregateId: 30,
      });
      expect((event as { payload: Record<string, unknown> }).payload).toMatchObject({
        ticketNo: 'TKT/MUM/2026-27/000030', isInWarranty: true,
      });
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'IN_PROGRESS' }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.resolve(ctx, 30, { resolution: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('warrantyClaim — validity / goodwill approval', () => {
    it('records an APPROVED claim and emits warranty_claim.approved', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'RESOLVED', isInWarranty: true }));
      repo.recordWarrantyClaim.mockResolvedValue(claim({ status: 'APPROVED', claimCost: 1200 }));
      const out = await service.warrantyClaim(ctx, 30, {
        warrantyId: 11, claimCost: 1200, decision: 'APPROVED', rowVersion: 1,
      });
      expect(out.status).toBe('APPROVED');
      const [, ticketId, warrantyId, claimCost, status, event] = repo.recordWarrantyClaim.mock.calls[0];
      expect(ticketId).toBe(30);
      expect(warrantyId).toBe(11);
      expect(claimCost).toBe(1200);
      expect(status).toBe('APPROVED');
      expect(event).toMatchObject({
        eventType: 'warranty_claim.approved', aggregateType: 'SERVICE_TICKET', aggregateId: 30,
      });
    });
    it('records a REJECTED claim WITHOUT emitting an event', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'IN_PROGRESS' }));
      repo.recordWarrantyClaim.mockResolvedValue(claim({ status: 'REJECTED', approvedBy: 5 }));
      const out = await service.warrantyClaim(ctx, 30, {
        warrantyId: 11, decision: 'REJECTED', rowVersion: 1,
      });
      expect(out.status).toBe('REJECTED');
      const event = repo.recordWarrantyClaim.mock.calls[0][5];
      expect(event).toBeUndefined();
    });
    it('409 when raising a claim on a CANCELLED ticket', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CANCELLED' }));
      await expect(code(service.warrantyClaim(ctx, 30, {
        warrantyId: 11, decision: 'APPROVED', rowVersion: 1,
      }))).resolves.toBe(409);
      expect(repo.recordWarrantyClaim).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('400 when nothing supplied to update', async () => {
      await expect(code(service.update(ctx, 30, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when terminal (CLOSED)', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'CLOSED' }));
      await expect(code(service.update(ctx, 30, { rowVersion: 1, priority: 'HIGH' }))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(ticket());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 30, { rowVersion: 1, priority: 'HIGH' }))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless OPEN', async () => {
      repo.findById.mockResolvedValue(ticket({ status: 'ASSIGNED' }));
      await expect(code(service.delete(ctx, 30))).resolves.toBe(409);
    });
    it('soft-deletes an OPEN ticket', async () => {
      repo.findById.mockResolvedValue(ticket());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
  });
});
