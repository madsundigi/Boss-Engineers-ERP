import { DeliveryService } from '../src/modules/delivery/delivery.service';
import { DeliveryRepository } from '../src/modules/delivery/delivery.repository';
import { RequestContext } from '../src/common/request-context';
import { DeliveryForecast } from '../src/modules/delivery/delivery.types';
import { OutboxEventInput } from '../src/outbox/outbox';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 7, username: 'planning', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function forecast(over: Partial<DeliveryForecast> = {}): DeliveryForecast {
  return {
    forecastId: 30, projectId: 100, forecastDate: '2026-06-07',
    predictedDelivery: '2026-09-15', committedDelivery: '2026-09-01',
    delayDays: 14, riskLevel: 'MEDIUM', driver: 'SCHEDULE',
    createdAt: 't', createdBy: 7, ...over,
  };
}

function makeRepo() {
  return {
    insert: jest.fn(),
    list: jest.fn(),
    findLatestForProject: jest.fn(),
    projectExists: jest.fn(),
    fetchRiskSignals: jest.fn(),
  } as unknown as jest.Mocked<DeliveryRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('DeliveryService', () => {
  let repo: jest.Mocked<DeliveryRepository>;
  let service: DeliveryService;
  beforeEach(() => { repo = makeRepo(); service = new DeliveryService(repo); });

  describe('createForecast', () => {
    it('passes the forecast through to repo.insert (created_by comes from ctx)', async () => {
      const created = forecast();
      repo.insert.mockResolvedValue(created);
      const out = await service.createForecast(ctx, {
        projectId: 100, predictedDelivery: '2026-09-15',
        committedDelivery: '2026-09-01', riskLevel: 'MEDIUM', driver: 'SCHEDULE',
      });
      expect(out).toBe(created);
      const [ctxArg, input] = repo.insert.mock.calls[0];
      expect(ctxArg).toBe(ctx); // created_by is derived from ctx.userId in the repo
      expect(input).toMatchObject({
        projectId: 100, predictedDelivery: '2026-09-15',
        committedDelivery: '2026-09-01', riskLevel: 'MEDIUM', driver: 'SCHEDULE',
      });
    });

    it('does NOT request the at-risk event for LOW risk', async () => {
      repo.insert.mockResolvedValue(forecast({ riskLevel: 'LOW' }));
      await service.createForecast(ctx, {
        projectId: 100, predictedDelivery: '2026-09-15', riskLevel: 'LOW',
      });
      expect(repo.insert.mock.calls[0][2]).toBeUndefined();
    });

    it('does NOT request the at-risk event for MEDIUM risk', async () => {
      repo.insert.mockResolvedValue(forecast({ riskLevel: 'MEDIUM' }));
      await service.createForecast(ctx, {
        projectId: 100, predictedDelivery: '2026-09-15', riskLevel: 'MEDIUM',
      });
      expect(repo.insert.mock.calls[0][2]).toBeUndefined();
    });

    it('does NOT request the at-risk event when risk is omitted', async () => {
      repo.insert.mockResolvedValue(forecast({ riskLevel: null }));
      await service.createForecast(ctx, { projectId: 100, predictedDelivery: '2026-09-15' });
      expect(repo.insert.mock.calls[0][2]).toBeUndefined();
    });

    it('requests delivery.at_risk (with payload) for HIGH risk', async () => {
      repo.insert.mockResolvedValue(forecast({ riskLevel: 'HIGH' }));
      await service.createForecast(ctx, {
        projectId: 100, predictedDelivery: '2026-09-15',
        committedDelivery: '2026-09-01', riskLevel: 'HIGH', driver: 'MATERIAL',
      });
      const event = repo.insert.mock.calls[0][2] as OutboxEventInput;
      expect(event).toMatchObject({
        eventType: 'delivery.at_risk', aggregateType: 'DELIVERY_FORECAST', aggregateId: 100,
        companyId: ctx.companyId, createdBy: ctx.userId,
      });
      expect(event.payload).toMatchObject({
        projectId: 100, predictedDelivery: '2026-09-15',
        committedDelivery: '2026-09-01', delayDays: 14, driver: 'MATERIAL',
      });
    });

    it('HIGH-risk payload delayDays is null when no commitment is given', async () => {
      repo.insert.mockResolvedValue(forecast({ riskLevel: 'HIGH', committedDelivery: null, delayDays: null }));
      await service.createForecast(ctx, {
        projectId: 100, predictedDelivery: '2026-09-15', riskLevel: 'HIGH',
      });
      const event = repo.insert.mock.calls[0][2] as OutboxEventInput;
      expect(event.payload).toMatchObject({ delayDays: null });
    });
  });

  describe('getLatestForProject', () => {
    it('404 when the project has no forecast', async () => {
      repo.findLatestForProject.mockResolvedValue(null);
      await expect(code(service.getLatestForProject(ctx, 100))).resolves.toBe(404);
    });
    it('returns the latest snapshot when one exists', async () => {
      const latest = forecast({ forecastId: 42 });
      repo.findLatestForProject.mockResolvedValue(latest);
      const out = await service.getLatestForProject(ctx, 100);
      expect(out).toBe(latest);
      expect(repo.findLatestForProject).toHaveBeenCalledWith(ctx, 100);
    });
  });

  describe('list', () => {
    it('passes filters + pagination straight through to the repo', async () => {
      const result = { rows: [forecast()], total: 1, page: 2, pageSize: 10 };
      repo.list.mockResolvedValue(result);
      const out = await service.list(ctx, { projectId: 100, riskLevel: 'HIGH', page: 2, pageSize: 10 });
      expect(out).toBe(result);
      expect(repo.list).toHaveBeenCalledWith(ctx, { projectId: 100, riskLevel: 'HIGH', page: 2, pageSize: 10 });
    });
  });

  // -------------------------------------------------------------------------
  // AUTO delivery-risk derivation. deriveRisk is a pure function (no I/O), so
  // the GREEN/YELLOW/RED + driver rules are asserted directly; getProjectRisk
  // is exercised against the fake repo for the 404 + signal-passthrough paths.
  // -------------------------------------------------------------------------
  describe('deriveRisk (pure GREEN/YELLOW/RED rule)', () => {
    const sig = (po: number, wo: number, fat: number) => ({
      overduePurchaseOrders: po, delayedWorkOrders: wo, pendingOrFailedFats: fat,
    });

    it('GREEN with null driver when all three signals are zero', () => {
      expect(DeliveryService.deriveRisk(sig(0, 0, 0))).toEqual({ riskLevel: 'GREEN', driver: null });
    });

    it('YELLOW + MATERIAL for a lone overdue PO (below the RED bar)', () => {
      expect(DeliveryService.deriveRisk(sig(1, 0, 0))).toEqual({ riskLevel: 'YELLOW', driver: 'MATERIAL' });
    });

    it('YELLOW + SCHEDULE for a lone delayed WO', () => {
      expect(DeliveryService.deriveRisk(sig(0, 2, 0))).toEqual({ riskLevel: 'YELLOW', driver: 'SCHEDULE' });
    });

    it('YELLOW + MATERIAL when PO+WO=2 (one each, still under threshold 3)', () => {
      // tie on count (1 vs 1): MATERIAL outranks SCHEDULE.
      expect(DeliveryService.deriveRisk(sig(1, 1, 0))).toEqual({ riskLevel: 'YELLOW', driver: 'MATERIAL' });
    });

    it('RED + QUALITY whenever any FAT is pending/failed (even a single one)', () => {
      expect(DeliveryService.deriveRisk(sig(0, 0, 1))).toEqual({ riskLevel: 'RED', driver: 'QUALITY' });
    });

    it('RED when overdue PO + delayed WO reach the threshold (3), driver = larger signal', () => {
      expect(DeliveryService.deriveRisk(sig(2, 1, 0))).toEqual({ riskLevel: 'RED', driver: 'MATERIAL' });
      expect(DeliveryService.deriveRisk(sig(1, 2, 0))).toEqual({ riskLevel: 'RED', driver: 'SCHEDULE' });
    });

    it('FAT dominates the driver when it is the largest signal in a RED', () => {
      expect(DeliveryService.deriveRisk(sig(1, 1, 5))).toEqual({ riskLevel: 'RED', driver: 'QUALITY' });
    });

    it('breaks a 3-way tie (1/1/1) to QUALITY (and is RED because FAT>0)', () => {
      expect(DeliveryService.deriveRisk(sig(1, 1, 1))).toEqual({ riskLevel: 'RED', driver: 'QUALITY' });
    });
  });

  describe('getProjectRisk', () => {
    it('404 when the project does not exist for the company', async () => {
      repo.projectExists.mockResolvedValue(false);
      await expect(code(service.getProjectRisk(ctx, 100))).resolves.toBe(404);
      expect(repo.fetchRiskSignals).not.toHaveBeenCalled(); // short-circuits before the signal read
    });

    it('returns the derived risk + raw signals for an existing project', async () => {
      repo.projectExists.mockResolvedValue(true);
      repo.fetchRiskSignals.mockResolvedValue({
        overduePurchaseOrders: 2, delayedWorkOrders: 1, pendingOrFailedFats: 0,
      });
      const out = await service.getProjectRisk(ctx, 100);
      expect(repo.fetchRiskSignals).toHaveBeenCalledWith(ctx, 100);
      expect(out).toMatchObject({
        projectId: 100,
        riskLevel: 'RED', // 2 + 1 >= 3
        driver: 'MATERIAL',
        signals: { overduePurchaseOrders: 2, delayedWorkOrders: 1, pendingOrFailedFats: 0 },
      });
      expect(typeof out.asOf).toBe('string');
    });

    it('maps an all-zero project to GREEN with a null driver', async () => {
      repo.projectExists.mockResolvedValue(true);
      repo.fetchRiskSignals.mockResolvedValue({
        overduePurchaseOrders: 0, delayedWorkOrders: 0, pendingOrFailedFats: 0,
      });
      const out = await service.getProjectRisk(ctx, 100);
      expect(out.riskLevel).toBe('GREEN');
      expect(out.driver).toBeNull();
    });
  });
});
