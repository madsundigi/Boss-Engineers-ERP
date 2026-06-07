import { PlanningService } from '../src/modules/planning/planning.service';
import { PlanningRepository } from '../src/modules/planning/planning.repository';
import { RequestContext } from '../src/common/request-context';
import { Baseline, Milestone, Task, WbsElement } from '../src/modules/planning/planning.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 7, username: 'planning', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function task(over: Partial<Task> = {}): Task {
  return {
    taskId: 10, projectId: 100, wbsId: null, taskName: 'Fab',
    plannedStart: '2026-06-01', plannedEnd: '2026-06-10',
    actualStart: null, actualEnd: null, baselineStart: null, baselineEnd: null,
    percentComplete: 0, isCriticalPath: false,
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1,
    durationDays: 10, dependencies: [], ...over,
  };
}

function wbs(over: Partial<WbsElement> = {}): WbsElement {
  return {
    wbsId: 5, projectId: 100, parentWbsId: null, wbsCode: '1.1', wbsName: 'Engineering',
    budgetAmount: 0, isBillingMilestone: false,
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1, ...over,
  };
}

function milestone(over: Partial<Milestone> = {}): Milestone {
  return {
    milestoneId: 3, projectId: 100, wbsId: null, name: 'Design Freeze',
    plannedDate: '2026-06-15', actualDate: null, isPaymentMilestone: false,
    billPct: null, billAmount: null, status: 'PENDING', ...over,
  };
}

function baseline(over: Partial<Baseline> = {}): Baseline {
  return {
    baselineId: 20, projectId: 100, baselineNo: 1,
    approvedBy: null, approvedAt: null, createdAt: 't', ...over,
  };
}

function makeRepo() {
  return {
    createWbs: jest.fn(),
    listWbs: jest.fn(),
    createTask: jest.fn(),
    findTaskById: jest.fn(),
    listTasks: jest.fn(),
    updateTask: jest.fn(),
    createMilestone: jest.fn(),
    findMilestoneById: jest.fn(),
    listMilestones: jest.fn(),
    updateMilestone: jest.fn(),
    createBaseline: jest.fn(),
    findBaselineById: jest.fn(),
    approveBaseline: jest.fn(),
  } as unknown as jest.Mocked<PlanningRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('PlanningService', () => {
  let repo: jest.Mocked<PlanningRepository>;
  let service: PlanningService;
  beforeEach(() => { repo = makeRepo(); service = new PlanningService(repo); });

  describe('createWbs', () => {
    it('delegates to the repo with the mapped fields', async () => {
      const created = wbs();
      repo.createWbs.mockResolvedValue(created);
      const out = await service.createWbs(ctx, 100, {
        wbsCode: '1.1', wbsName: 'Engineering', budgetAmount: 0, isBillingMilestone: false,
      });
      expect(out).toBe(created);
      expect(repo.createWbs).toHaveBeenCalledWith(ctx, 100, {
        wbsCode: '1.1', wbsName: 'Engineering', parentWbsId: undefined,
        budgetAmount: 0, isBillingMilestone: false,
      });
    });
  });

  describe('createTask', () => {
    it('creates a task (status defaults; dependencies normalized)', async () => {
      const created = task();
      repo.createTask.mockResolvedValue(created);
      const out = await service.createTask(ctx, 100, {
        taskName: 'Fab', plannedStart: '2026-06-01', plannedEnd: '2026-06-10', percentComplete: 0,
        dependencies: [{ predTaskId: 9, depType: 'FS', lagDays: 0 }],
      });
      expect(out).toBe(created);
      expect(repo.createTask).toHaveBeenCalledWith(ctx, 100, expect.objectContaining({
        taskName: 'Fab', plannedStart: '2026-06-01', plannedEnd: '2026-06-10',
        dependencies: [{ predTaskId: 9, depType: 'FS', lagDays: 0 }],
      }));
    });
    it('400 when plannedEnd precedes plannedStart', async () => {
      await expect(code(service.createTask(ctx, 100, {
        taskName: 'X', plannedStart: '2026-06-10', plannedEnd: '2026-06-01', percentComplete: 0,
      }))).resolves.toBe(400);
      expect(repo.createTask).not.toHaveBeenCalled();
    });
    it('400 on a duplicate predecessor', async () => {
      await expect(code(service.createTask(ctx, 100, {
        taskName: 'X', plannedStart: '2026-06-01', plannedEnd: '2026-06-10', percentComplete: 0,
        dependencies: [
          { predTaskId: 9, depType: 'FS', lagDays: 0 },
          { predTaskId: 9, depType: 'SS', lagDays: 1 },
        ],
      }))).resolves.toBe(400);
    });
  });

  describe('getTask', () => {
    it('404 when not found', async () => {
      repo.findTaskById.mockResolvedValue(null);
      await expect(code(service.getTask(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('updateTask', () => {
    it('400 when no fields supplied', async () => {
      await expect(code(service.updateTask(ctx, 10, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('400 when a task is made to depend on itself', async () => {
      repo.findTaskById.mockResolvedValue(task());
      await expect(code(service.updateTask(ctx, 10, {
        rowVersion: 1, dependencies: [{ predTaskId: 10, depType: 'FS', lagDays: 0 }],
      }))).resolves.toBe(400);
    });
    it('400 when the resulting window is inverted', async () => {
      repo.findTaskById.mockResolvedValue(task({ plannedStart: '2026-06-01', plannedEnd: '2026-06-10' }));
      await expect(code(service.updateTask(ctx, 10, { rowVersion: 1, plannedEnd: '2026-05-01' }))).resolves.toBe(400);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findTaskById.mockResolvedValue(task());
      repo.updateTask.mockResolvedValue(null);
      await expect(code(service.updateTask(ctx, 10, { rowVersion: 1, percentComplete: 50 }))).resolves.toBe(409);
    });
    it('updates % complete and returns the new row', async () => {
      repo.findTaskById.mockResolvedValue(task());
      repo.updateTask.mockResolvedValue(task({ percentComplete: 50, rowVersion: 2 }));
      const out = await service.updateTask(ctx, 10, { rowVersion: 1, percentComplete: 50 });
      expect(out.percentComplete).toBe(50);
      expect(repo.updateTask).toHaveBeenCalledWith(ctx, 10, 1, expect.objectContaining({ percentComplete: 50 }));
    });
  });

  describe('updateMilestone', () => {
    it('404 when the milestone does not exist', async () => {
      repo.findMilestoneById.mockResolvedValue(null);
      await expect(code(service.updateMilestone(ctx, 3, { status: 'ACHIEVED' }))).resolves.toBe(404);
    });
    it('moves a milestone to ACHIEVED', async () => {
      repo.findMilestoneById.mockResolvedValue(milestone());
      repo.updateMilestone.mockResolvedValue(milestone({ status: 'ACHIEVED' }));
      const out = await service.updateMilestone(ctx, 3, { status: 'ACHIEVED' });
      expect(out.status).toBe('ACHIEVED');
    });
  });

  describe('approveBaseline', () => {
    it('404 when the baseline does not exist', async () => {
      repo.findBaselineById.mockResolvedValue(null);
      await expect(code(service.approveBaseline(ctx, { baselineId: 999 }))).resolves.toBe(404);
    });
    it('409 when the baseline is already approved', async () => {
      repo.findBaselineById.mockResolvedValue(baseline({ approvedAt: 't', approvedBy: 8 }));
      await expect(code(service.approveBaseline(ctx, { baselineId: 20 }))).resolves.toBe(409);
    });
    it('approves an unapproved baseline and emits the domain event', async () => {
      repo.findBaselineById.mockResolvedValue(baseline());
      repo.approveBaseline.mockResolvedValue(baseline({ approvedAt: 't', approvedBy: 7 }));
      const out = await service.approveBaseline(ctx, { baselineId: 20 });
      expect(out.approvedBy).toBe(7);
      const eventArg = repo.approveBaseline.mock.calls[0][2];
      expect(eventArg).toMatchObject({
        eventType: 'planning.baseline.approved', aggregateType: 'PLANNING_BASELINE', aggregateId: 20,
      });
    });
  });
});
