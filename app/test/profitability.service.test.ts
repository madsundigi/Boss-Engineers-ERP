import {
  ProfitabilityService, marginPct, costPerformanceIndex, forecastEac,
} from '../src/modules/profitability/profitability.service';
import {
  ProfitabilityRepository, ProjectFinancials, ProjectRef,
} from '../src/modules/profitability/profitability.repository';
import { RequestContext } from '../src/common/request-context';
import { MarginSnapshot } from '../src/modules/profitability/profitability.types';
import { OutboxEventInput } from '../src/outbox/outbox';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 9, username: 'finance', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function snapshot(over: Partial<MarginSnapshot> = {}): MarginSnapshot {
  return {
    snapshotId: 50, projectId: 100, snapshotDate: '2026-06-07',
    revenue: 1000, committedCost: 400, actualCost: 300, forecastCostEac: 400,
    marginPct: 70, cpi: 1, spi: null, ...over,
  };
}

const project: ProjectRef = { projectId: 100, companyId: 1, status: 'ACTIVE' };

function makeRepo() {
  return {
    findProject: jest.fn(),
    aggregateFinancials: jest.fn(),
    insert: jest.fn(),
    list: jest.fn(),
    findLatestForProject: jest.fn(),
    portfolioMargin: jest.fn(),
    costByCategory: jest.fn(),
  } as unknown as jest.Mocked<ProfitabilityRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('profitability formulas (pure)', () => {
  describe('marginPct', () => {
    it('(revenue - actualCost) / revenue * 100 when revenue > 0', () => {
      expect(marginPct(1000, 300)).toBe(70);
      expect(marginPct(1000, 1200)).toBe(-20); // a loss yields a negative margin
    });
    it('null when revenue is 0 (or negative) — avoids divide-by-zero', () => {
      expect(marginPct(0, 300)).toBeNull();
      expect(marginPct(-5, 300)).toBeNull();
    });
  });

  describe('costPerformanceIndex (CPI = budget / actual)', () => {
    it('budgetCost / actualCost when actual > 0', () => {
      expect(costPerformanceIndex(500, 250)).toBe(2);
      expect(costPerformanceIndex(300, 400)).toBe(0.75);
    });
    it('null when actualCost is 0 — avoids divide-by-zero', () => {
      expect(costPerformanceIndex(500, 0)).toBeNull();
    });
  });

  describe('forecastEac (actual + GREATEST(committed - actual, 0))', () => {
    it('adds the remaining commitment over actuals', () => {
      expect(forecastEac(400, 300)).toBe(400); // 300 + max(100, 0)
    });
    it('floors the remaining-commitment term at 0 once actuals exceed commitments', () => {
      expect(forecastEac(200, 500)).toBe(500); // 500 + max(-300, 0) -> 500
    });
  });
});

describe('ProfitabilityService', () => {
  let repo: jest.Mocked<ProfitabilityRepository>;
  let service: ProfitabilityService;
  beforeEach(() => { repo = makeRepo(); service = new ProfitabilityService(repo); });

  describe('computeSnapshot', () => {
    const fin: ProjectFinancials = { revenue: 1000, budgetCost: 500, committedCost: 400, actualCost: 250 };

    it('404 when the project does not exist (no aggregation, no insert)', async () => {
      repo.findProject.mockResolvedValue(null);
      await expect(code(service.computeSnapshot(ctx, { projectId: 100 }))).resolves.toBe(404);
      expect(repo.aggregateFinancials).not.toHaveBeenCalled();
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('derives margin/CPI/EAC from the aggregated financials and inserts the snapshot', async () => {
      repo.findProject.mockResolvedValue(project);
      repo.aggregateFinancials.mockResolvedValue(fin);
      repo.insert.mockImplementation(async (_c, input) => snapshot({
        revenue: input.revenue, committedCost: input.committedCost, actualCost: input.actualCost,
        forecastCostEac: input.forecastCostEac, marginPct: input.marginPct, cpi: input.cpi, spi: input.spi,
      }));

      const out = await service.computeSnapshot(ctx, { projectId: 100 });
      const [ctxArg, input] = repo.insert.mock.calls[0];
      expect(ctxArg).toBe(ctx); // company_id / created_by derive from ctx in the repo
      expect(input).toMatchObject({
        projectId: 100,
        revenue: 1000,
        committedCost: 400,
        actualCost: 250,
        forecastCostEac: 400,         // 250 + max(400 - 250, 0)
        marginPct: 75,                // (1000 - 250) / 1000 * 100
        cpi: 2,                       // budget 500 / actual 250
        spi: null,                    // no schedule baseline in this module
      });
      expect(out.marginPct).toBe(75);
    });

    it('emits margin.snapshot.created atomically with the insert (payload from inputs)', async () => {
      repo.findProject.mockResolvedValue(project);
      repo.aggregateFinancials.mockResolvedValue(fin);
      repo.insert.mockResolvedValue(snapshot());

      await service.computeSnapshot(ctx, { projectId: 100 });
      const event = repo.insert.mock.calls[0][2] as OutboxEventInput;
      expect(event).toMatchObject({
        eventType: 'margin.snapshot.created', aggregateType: 'MARGIN_SNAPSHOT', aggregateId: 100,
        companyId: ctx.companyId, createdBy: ctx.userId,
      });
      expect(event.payload).toMatchObject({
        projectId: 100, revenue: 1000, actualCost: 250, marginPct: 75,
      });
    });

    it('margin_pct is null in the snapshot + event when the project has no revenue', async () => {
      repo.findProject.mockResolvedValue(project);
      repo.aggregateFinancials.mockResolvedValue({ revenue: 0, budgetCost: 100, committedCost: 50, actualCost: 0 });
      repo.insert.mockResolvedValue(snapshot({ marginPct: null }));

      await service.computeSnapshot(ctx, { projectId: 100 });
      const input = repo.insert.mock.calls[0][1];
      expect(input.marginPct).toBeNull();
      expect(input.cpi).toBeNull(); // actual cost 0 -> CPI null
      const event = repo.insert.mock.calls[0][2] as OutboxEventInput;
      expect(event.payload).toMatchObject({ marginPct: null });
    });
  });

  describe('getLatestForProject', () => {
    it('404 when the project has no snapshot', async () => {
      repo.findLatestForProject.mockResolvedValue(null);
      await expect(code(service.getLatestForProject(ctx, 100))).resolves.toBe(404);
    });
    it('returns the latest snapshot when one exists', async () => {
      const latest = snapshot({ snapshotId: 77 });
      repo.findLatestForProject.mockResolvedValue(latest);
      const out = await service.getLatestForProject(ctx, 100);
      expect(out).toBe(latest);
      expect(repo.findLatestForProject).toHaveBeenCalledWith(ctx, 100);
    });
  });

  describe('projectPnl', () => {
    it('expands the latest snapshot into a P&L shape (grossMargin = revenue - actualCost)', async () => {
      repo.findLatestForProject.mockResolvedValue(snapshot({ revenue: 1000, actualCost: 300 }));
      repo.costByCategory.mockResolvedValue([]);
      const pnl = await service.projectPnl(ctx, 100);
      expect(pnl).toMatchObject({
        projectId: 100, revenue: 1000, actualCost: 300, grossMargin: 700, marginPct: 70,
      });
    });
    it('attaches the ledger cost broken down by category from the repo', async () => {
      repo.findLatestForProject.mockResolvedValue(snapshot());
      const byCat = [
        { category: 'MATERIAL', amount: 300 },
        { category: 'INSTALLATION', amount: 120 },
      ];
      repo.costByCategory.mockResolvedValue(byCat);
      const pnl = await service.projectPnl(ctx, 100);
      expect(repo.costByCategory).toHaveBeenCalledWith(ctx, 100);
      expect(pnl.costByCategory).toEqual(byCat);
    });
    it('404 when the project has no snapshot (no cost-by-category lookup)', async () => {
      repo.findLatestForProject.mockResolvedValue(null);
      await expect(code(service.projectPnl(ctx, 100))).resolves.toBe(404);
      expect(repo.costByCategory).not.toHaveBeenCalled();
    });
  });

  describe('list / portfolioMargin', () => {
    it('passes list filters + pagination straight through to the repo', async () => {
      const result = { rows: [snapshot()], total: 1, page: 2, pageSize: 10 };
      repo.list.mockResolvedValue(result);
      const out = await service.list(ctx, { projectId: 100, page: 2, pageSize: 10 });
      expect(out).toBe(result);
      expect(repo.list).toHaveBeenCalledWith(ctx, { projectId: 100, page: 2, pageSize: 10 });
    });
    it('passes portfolioMargin straight through to the repo', async () => {
      const rows = [{ projectId: 100, snapshotId: 50, snapshotDate: '2026-06-07', revenue: 1000, actualCost: 300, marginPct: 70 }];
      repo.portfolioMargin.mockResolvedValue(rows);
      const out = await service.portfolioMargin(ctx);
      expect(out).toBe(rows);
      expect(repo.portfolioMargin).toHaveBeenCalledWith(ctx);
    });
  });
});
