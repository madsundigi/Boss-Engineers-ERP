import { ProjectService } from '../src/modules/project/project.service';
import { ProjectRepository } from '../src/modules/project/project.repository';
import { RequestContext } from '../src/common/request-context';
import { Project } from '../src/modules/project/project.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 1, username: 'planner', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

const sample: Project = {
  projectId: 10, projectNo: 'PRJ/MUM/2026-27/00010', companyId: 1, buId: 1,
  projectName: 'EOT Crane Package', customerId: 5, quotationId: null, enquiryId: null,
  contractValue: 9500000, budgetCost: 8000000, pmUserId: 7,
  plannedStart: null, plannedEnd: null, contractualEnd: null, ldPctPerWeek: null,
  status: 'PLANNING', healthRag: null, createdAt: 't', createdBy: 1, updatedAt: 't', rowVersion: 1,
};

const baseCreate = {
  projectName: 'EOT Crane Package', customerId: 5, pmUserId: 7,
  contractValue: 9500000, budgetCost: 8000000,
};

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<ProjectRepository>;
}

const status = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('ProjectService', () => {
  let repo: jest.Mocked<ProjectRepository>;
  let service: ProjectService;
  beforeEach(() => { repo = makeRepo(); service = new ProjectService(repo); });

  describe('create', () => {
    it('creates with branch context, defaults status PLANNING, emits project.created', async () => {
      repo.create.mockResolvedValue(sample);
      const out = await service.create(ctx, baseCreate);
      expect(out).toBe(sample);
      const [, data, event] = repo.create.mock.calls[0];
      expect(data).toMatchObject({ projectName: 'EOT Crane Package', customerId: 5, pmUserId: 7 });
      expect(event?.eventType).toBe('project.created');
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(status(service.create({ ...ctx, buId: null }, baseCreate))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(status(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('update', () => {
    it('400 when no fields supplied', async () => {
      await expect(status(service.update(ctx, 10, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('409 when project is past the charter phase (ACTIVE)', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'ACTIVE' });
      await expect(status(service.update(ctx, 10, { rowVersion: 1, projectName: 'X' }))).resolves.toBe(409);
    });
    it('409 on row-version mismatch', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.update.mockResolvedValue(null);
      await expect(status(service.update(ctx, 10, { rowVersion: 1, projectName: 'X' }))).resolves.toBe(409);
    });
    it('updates only supplied fields', async () => {
      repo.findById.mockResolvedValue(sample);
      repo.update.mockResolvedValue({ ...sample, projectName: 'X', rowVersion: 2 });
      const out = await service.update(ctx, 10, { rowVersion: 1, projectName: 'X' });
      expect(out.projectName).toBe('X');
      expect(repo.update).toHaveBeenCalledWith(ctx, 10, 1, { projectName: 'X' });
    });
  });

  describe('changeStatus', () => {
    it('409 on an illegal transition (PLANNING -> DELIVERED)', async () => {
      repo.findById.mockResolvedValue(sample);
      await expect(status(service.changeStatus(ctx, 10, { status: 'DELIVERED', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('400 when cancelling without a reason', async () => {
      repo.findById.mockResolvedValue(sample);
      await expect(status(service.changeStatus(ctx, 10, { status: 'CANCELLED', rowVersion: 1 }))).resolves.toBe(400);
    });
    it('allows a valid transition (ACTIVE -> ON_HOLD)', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'ACTIVE' });
      repo.updateStatus.mockResolvedValue({ ...sample, status: 'ON_HOLD', rowVersion: 2 });
      const out = await service.changeStatus(ctx, 10, { status: 'ON_HOLD', rowVersion: 1 });
      expect(out.status).toBe('ON_HOLD');
    });
  });

  describe('approve (charter sign-off)', () => {
    it('409 unless current status is PLANNING', async () => {
      repo.findById.mockResolvedValue({ ...sample, status: 'ACTIVE', createdBy: 2 });
      await expect(status(service.approve(ctx, 10, 1))).resolves.toBe(409);
    });
    it('403 when the creator approves their own project (Segregation of Duties)', async () => {
      repo.findById.mockResolvedValue({ ...sample, createdBy: ctx.userId });
      await expect(status(service.approve(ctx, 10, 1))).resolves.toBe(403);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('approves a PLANNING project created by someone else -> APPROVED', async () => {
      repo.findById.mockResolvedValue({ ...sample, createdBy: 2 });
      repo.updateStatus.mockResolvedValue({ ...sample, status: 'APPROVED', rowVersion: 2 });
      const out = await service.approve(ctx, 10, 1);
      expect(out.status).toBe('APPROVED');
      const [, , , target, , event] = repo.updateStatus.mock.calls[0];
      expect(target).toBe('APPROVED');
      expect(event?.eventType).toBe('project.approved');
    });
    it('409 on row-version mismatch at approve', async () => {
      repo.findById.mockResolvedValue({ ...sample, createdBy: 2 });
      repo.updateStatus.mockResolvedValue(null);
      await expect(status(service.approve(ctx, 10, 1))).resolves.toBe(409);
    });
  });
});
