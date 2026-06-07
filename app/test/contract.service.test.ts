import { ContractService } from '../src/modules/contract/contract.service';
import { ContractRepository } from '../src/modules/contract/contract.repository';
import { RequestContext } from '../src/common/request-context';
import { Contract, ContractMilestone } from '../src/modules/contract/contract.types';
import { AppError } from '../src/common/http-error';
import { CONTRACT_ACTIVATED_EVENT } from '../src/modules/contract/contract.constants';

const ctx: RequestContext = {
  userId: 5, username: 'sales', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function milestone(over: Partial<ContractMilestone> = {}): ContractMilestone {
  return {
    milestoneId: 70, name: 'Advance', milestonePct: 30, amount: 30000,
    dueDate: '2026-07-01', status: 'PENDING', sortOrder: 1, ...over,
  };
}

function contract(over: Partial<Contract> = {}): Contract {
  return {
    contractId: 40, contractNo: 'CON/MUM/2026-27/000040', companyId: 1, buId: 1,
    customerId: 50, projectId: 100, title: 'Supply & Install', contractValue: 100000,
    currencyId: 9, paymentTerms: '30% advance, 60% on delivery, 10% on FAT',
    ldPenaltyPct: 0.5, ldCapPct: 10, warrantyMonths: 12,
    startDate: '2026-06-01', endDate: '2027-06-01', status: 'DRAFT', signedDate: '2026-05-20',
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1,
    milestones: [milestone()], ...over,
  };
}

function makeRepo() {
  return {
    resolveInrCurrencyId: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    setMilestoneStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<ContractRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ContractService', () => {
  let repo: jest.Mocked<ContractRepository>;
  let service: ContractService;
  beforeEach(() => { repo = makeRepo(); service = new ContractService(repo); });

  describe('create', () => {
    it('creates in DRAFT, resolving INR when no currency supplied', async () => {
      const created = contract();
      repo.resolveInrCurrencyId.mockResolvedValue(9);
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { customerId: 50, contractValue: 100000 });
      expect(out).toBe(created);
      const [, header] = repo.create.mock.calls[0];
      expect(header).toMatchObject({ customerId: 50, currencyId: 9, contractValue: 100000 });
    });

    it('derives a milestone amount from its pct x contract value', async () => {
      repo.create.mockResolvedValue(contract());
      await service.create(ctx, {
        customerId: 50, contractValue: 200000, currencyId: 9,
        milestones: [{ name: 'Advance', milestonePct: 25 }],
      });
      const [, , milestones] = repo.create.mock.calls[0];
      expect(milestones).toEqual([
        { name: 'Advance', milestonePct: 25, amount: 50000, dueDate: undefined, sortOrder: undefined },
      ]);
    });

    it('uses an explicit milestone amount over the pct', async () => {
      repo.create.mockResolvedValue(contract());
      await service.create(ctx, {
        customerId: 50, contractValue: 200000, currencyId: 9,
        milestones: [{ name: 'Advance', milestonePct: 25, amount: 60000 }],
      });
      const [, , milestones] = repo.create.mock.calls[0];
      expect(milestones[0].amount).toBe(60000);
    });

    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { customerId: 50, contractValue: 0 })))
        .resolves.toBe(400);
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
    it('409 when editing a non-DRAFT contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'ACTIVE' }));
      await expect(code(service.update(ctx, 40, { title: 'x', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(contract());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 40, { title: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('activate (DRAFT -> ACTIVE, SoD + event)', () => {
    it('emits contract.activated with the expected payload', async () => {
      repo.findById.mockResolvedValue(contract({ createdBy: 5 }));
      repo.updateStatus.mockResolvedValue(contract({ status: 'ACTIVE', rowVersion: 2 }));
      // activator (7) differs from creator (5) -> SoD passes
      const activator: RequestContext = { ...ctx, userId: 7 };
      const out = await service.activate(activator, 40, 1);
      expect(out.status).toBe('ACTIVE');
      const [, , , status, event] = repo.updateStatus.mock.calls[0];
      expect(status).toBe('ACTIVE');
      expect(event).toMatchObject({
        eventType: CONTRACT_ACTIVATED_EVENT,
        aggregateType: 'CONTRACT',
        payload: { contractNo: 'CON/MUM/2026-27/000040', customerId: 50, projectId: 100, contractValue: 100000 },
      });
    });

    it('blocks the creator from activating their own contract (403, SoD)', async () => {
      repo.findById.mockResolvedValue(contract({ createdBy: 5 }));
      await expect(code(service.activate(ctx, 40, 1))).resolves.toBe(403); // ctx.userId === createdBy
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('409 when activating a non-DRAFT contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'ACTIVE', createdBy: 99 }));
      await expect(code(service.activate(ctx, 40, 1))).resolves.toBe(409);
    });

    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(contract({ createdBy: 99 }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.activate(ctx, 40, 1))).resolves.toBe(409);
    });
  });

  describe('close', () => {
    it('409 when closing a contract that is not ACTIVE', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'DRAFT' }));
      await expect(code(service.close(ctx, 40, 1))).resolves.toBe(409);
    });
    it('closes an ACTIVE contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'ACTIVE' }));
      repo.updateStatus.mockResolvedValue(contract({ status: 'CLOSED', rowVersion: 3 }));
      const out = await service.close(ctx, 40, 2);
      expect(out.status).toBe('CLOSED');
    });
  });

  describe('milestone transitions', () => {
    it('marks a PENDING milestone INVOICED', async () => {
      repo.findById.mockResolvedValue(contract({ milestones: [milestone({ status: 'PENDING' })] }));
      repo.setMilestoneStatus.mockResolvedValue(
        contract({ milestones: [milestone({ status: 'INVOICED' })], rowVersion: 2 }));
      const out = await service.markMilestoneInvoiced(ctx, 40, 70);
      expect(out.milestones[0].status).toBe('INVOICED');
      const [, , milestoneId, status] = repo.setMilestoneStatus.mock.calls[0];
      expect(milestoneId).toBe(70);
      expect(status).toBe('INVOICED');
    });

    it('marks an INVOICED milestone PAID', async () => {
      repo.findById.mockResolvedValue(contract({ milestones: [milestone({ status: 'INVOICED' })] }));
      repo.setMilestoneStatus.mockResolvedValue(
        contract({ milestones: [milestone({ status: 'PAID' })], rowVersion: 3 }));
      const out = await service.markMilestonePaid(ctx, 40, 70);
      expect(out.milestones[0].status).toBe('PAID');
    });

    it('409 on an illegal milestone transition (PENDING -> PAID)', async () => {
      repo.findById.mockResolvedValue(contract({ milestones: [milestone({ status: 'PENDING' })] }));
      await expect(code(service.markMilestonePaid(ctx, 40, 70))).resolves.toBe(409);
      expect(repo.setMilestoneStatus).not.toHaveBeenCalled();
    });

    it('404 when the milestone is not on the contract', async () => {
      repo.findById.mockResolvedValue(contract({ milestones: [milestone({ milestoneId: 71 })] }));
      await expect(code(service.markMilestoneInvoiced(ctx, 40, 70))).resolves.toBe(404);
    });
  });

  describe('cancel / delete', () => {
    it('cancels a DRAFT contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'DRAFT' }));
      repo.updateStatus.mockResolvedValue(contract({ status: 'CANCELLED', rowVersion: 2 }));
      const out = await service.cancel(ctx, 40, { reason: 'lost the order', rowVersion: 1 });
      expect(out.status).toBe('CANCELLED');
    });
    it('409 when cancelling a CLOSED contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'CLOSED' }));
      await expect(code(service.cancel(ctx, 40, { reason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when deleting a non-DRAFT contract', async () => {
      repo.findById.mockResolvedValue(contract({ status: 'ACTIVE' }));
      await expect(code(service.delete(ctx, 40))).resolves.toBe(409);
      expect(repo.softDelete).not.toHaveBeenCalled();
    });
  });
});
