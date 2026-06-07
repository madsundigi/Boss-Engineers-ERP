import { FatService } from '../src/modules/fat/fat.service';
import { FatRepository } from '../src/modules/fat/fat.repository';
import { RequestContext } from '../src/common/request-context';
import { Fat } from '../src/modules/fat/fat.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 7, username: 'qc', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function fat(over: Partial<Fat> = {}): Fat {
  return {
    fatId: 10, fatNo: 'FAT/MUM/2026-27/00010', companyId: 1, buId: 1,
    projectId: 100, woId: null, protocolId: 200, fatDate: '2026-06-07',
    status: 'SCHEDULED', result: null, customerWitness: null, signoffBy: null,
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1,
    resultLines: [], punchItems: [], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    recordResult: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<FatRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('FatService', () => {
  let repo: jest.Mocked<FatRepository>;
  let service: FatService;
  beforeEach(() => { repo = makeRepo(); service = new FatService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults SCHEDULED)', async () => {
      const created = fat();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { projectId: 100, protocolId: 200 });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(ctx, {
        projectId: 100, protocolId: 200, woId: undefined, fatDate: undefined, customerWitness: undefined,
      });
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { projectId: 100, protocolId: 200 }))).resolves.toBe(400);
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
    it('409 when FAT is terminal (CLEARED)', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'CLEARED' }));
      await expect(code(service.update(ctx, 10, { rowVersion: 1, customerWitness: 'X' }))).resolves.toBe(409);
    });
    it('409 on row-version mismatch', async () => {
      repo.findById.mockResolvedValue(fat());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 10, { rowVersion: 1, customerWitness: 'X' }))).resolves.toBe(409);
    });
  });

  describe('recordResult', () => {
    it('409 when not SCHEDULED/IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'CLEARED' }));
      await expect(code(service.recordResult(ctx, 10, { result: 'PASS', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('400 when a non-PASS result carries no punch list', async () => {
      repo.findById.mockResolvedValue(fat());
      await expect(code(service.recordResult(ctx, 10, { result: 'FAIL', rowVersion: 1 }))).resolves.toBe(400);
    });
    it('records a PASS and moves status to PASSED', async () => {
      repo.findById.mockResolvedValue(fat());
      repo.recordResult.mockResolvedValue(fat({ status: 'PASSED', result: 'PASS', rowVersion: 2 }));
      const out = await service.recordResult(ctx, 10, { result: 'PASS', rowVersion: 1 });
      expect(out.status).toBe('PASSED');
      expect(repo.recordResult).toHaveBeenCalledWith(ctx, 10, 1, 'PASSED', 'PASS', [], []);
    });
    it('records a FAIL with a punch list and moves status to FAILED', async () => {
      repo.findById.mockResolvedValue(fat());
      repo.recordResult.mockResolvedValue(fat({ status: 'FAILED', result: 'FAIL', rowVersion: 2 }));
      const out = await service.recordResult(ctx, 10, {
        result: 'FAIL', rowVersion: 1, punchItems: [{ description: 'Leak at flange', severity: 'HIGH' }],
      });
      expect(out.status).toBe('FAILED');
      const [, , , statusArg, resultArg, , punchArg] = repo.recordResult.mock.calls[0];
      expect(statusArg).toBe('FAILED');
      expect(resultArg).toBe('FAIL');
      expect(punchArg).toHaveLength(1);
    });
  });

  describe('changeStatus', () => {
    it('409 on an illegal transition (SCHEDULED -> PASSED)', async () => {
      repo.findById.mockResolvedValue(fat());
      await expect(code(service.changeStatus(ctx, 10, { status: 'PASSED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when trying to CLEAR via /status (must use /approve)', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'PASSED' }));
      await expect(code(service.changeStatus(ctx, 10, { status: 'CLEARED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('allows a valid transition (SCHEDULED -> IN_PROGRESS)', async () => {
      repo.findById.mockResolvedValue(fat());
      repo.updateStatus.mockResolvedValue(fat({ status: 'IN_PROGRESS', rowVersion: 2 }));
      const out = await service.changeStatus(ctx, 10, { status: 'IN_PROGRESS', rowVersion: 1 });
      expect(out.status).toBe('IN_PROGRESS');
    });
  });

  describe('approve (sign-off / Dispatch clearance)', () => {
    it('409 unless status is PASSED', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'IN_PROGRESS' }));
      await expect(code(service.approve(ctx, 10, { rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when there are open punch items', async () => {
      repo.findById.mockResolvedValue(fat({
        status: 'PASSED', result: 'PASS',
        punchItems: [{ description: 'x', severity: 'LOW', status: 'OPEN', closedDate: null }],
      }));
      await expect(code(service.approve(ctx, 10, { rowVersion: 1 }))).resolves.toBe(409);
    });
    it('clears a PASSED FAT and emits fat.passed (via updateStatus event arg)', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'PASSED', result: 'PASS' }));
      repo.updateStatus.mockResolvedValue(fat({ status: 'CLEARED', result: 'PASS', signoffBy: 7, rowVersion: 2 }));
      const out = await service.approve(ctx, 10, { rowVersion: 1, customerWitness: 'Mr. Client' });
      expect(out.status).toBe('CLEARED');
      const eventArg = repo.updateStatus.mock.calls[0][5];
      expect(eventArg).toMatchObject({ eventType: 'fat.passed', aggregateType: 'FAT', aggregateId: 10 });
    });
  });

  describe('delete', () => {
    it('409 unless status is SCHEDULED', async () => {
      repo.findById.mockResolvedValue(fat({ status: 'IN_PROGRESS' }));
      await expect(code(service.delete(ctx, 10))).resolves.toBe(409);
    });
    it('soft-deletes a SCHEDULED FAT', async () => {
      repo.findById.mockResolvedValue(fat());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 10);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 10);
    });
  });
});
