import { TreasuryService } from '../src/modules/treasury/treasury.service';
import { TreasuryRepository } from '../src/modules/treasury/treasury.repository';
import { RequestContext } from '../src/common/request-context';
import { CashflowForecast, CashflowSummaryRow, WorkingCapitalPosition } from '../src/modules/treasury/treasury.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const forecast = (o: Partial<CashflowForecast> = {}): CashflowForecast => ({
  cfId: 7, companyId: 1, buId: 1, forecastDate: '2026-07-01', periodLabel: '2026-07',
  direction: 'INFLOW', category: 'MILESTONE', amount: 500000, projectId: 9, note: null,
  createdAt: '', createdBy: 1, ...o,
});

function make(over: Partial<TreasuryRepository> = {}) {
  const repo = {
    insert: jest.fn(async () => forecast()),
    list: jest.fn(async () => ({ rows: [forecast()], total: 1, page: 1, pageSize: 25 })),
    summary: jest.fn(async (): Promise<CashflowSummaryRow[]> => []),
    position: jest.fn(async (): Promise<WorkingCapitalPosition> => ({
      arOutstanding: 0, apOutstanding: 0, netForecast: 0, workingCapitalGap: 0,
    })),
    ...over,
  } as unknown as TreasuryRepository;
  return { svc: new TreasuryService(repo), repo };
}

describe('TreasuryService', () => {
  it('addForecast delegates to the repository with the mapped input', async () => {
    const { svc, repo } = make();
    await svc.addForecast(ctx, {
      periodLabel: '2026-07', direction: 'INFLOW', category: 'MILESTONE', amount: 500000, projectId: 9,
    });
    expect(repo.insert).toHaveBeenCalledTimes(1);
    expect(repo.insert).toHaveBeenCalledWith(ctx, expect.objectContaining({
      periodLabel: '2026-07', direction: 'INFLOW', amount: 500000, projectId: 9,
    }));
  });

  it('list delegates to the repository', async () => {
    const { svc, repo } = make();
    const out = await svc.list(ctx, { page: 1, pageSize: 25 });
    expect(repo.list).toHaveBeenCalled();
    expect(out.total).toBe(1);
  });

  it('forecastSummary maps the repository output through unchanged', async () => {
    const rows: CashflowSummaryRow[] = [
      { periodLabel: '2026-07', inflow: 500000, outflow: 200000, net: 300000 },
      { periodLabel: '2026-08', inflow: 0, outflow: 150000, net: -150000 },
    ];
    const { svc, repo } = make({ summary: jest.fn(async () => rows) });
    const out = await svc.forecastSummary(ctx, 9);
    expect(repo.summary).toHaveBeenCalledWith(ctx, 9);
    expect(out).toEqual(rows);
    expect(out[0].net).toBe(300000);
    expect(out[1].net).toBe(-150000);
  });

  it('position assembles AR/AP/net-forecast/gap from the repository', async () => {
    const { svc, repo } = make({
      position: jest.fn(async () => ({
        arOutstanding: 1_200_000, apOutstanding: 800_000, netForecast: 50_000, workingCapitalGap: 400_000,
      })),
    });
    const pos = await svc.position(ctx);
    expect(repo.position).toHaveBeenCalledWith(ctx);
    expect(pos.arOutstanding).toBe(1_200_000);
    expect(pos.apOutstanding).toBe(800_000);
    expect(pos.netForecast).toBe(50_000);
    expect(pos.workingCapitalGap).toBe(400_000);
  });

  it('position never throws on an all-zero (empty company) snapshot', async () => {
    const { svc } = make(); // default repo returns all zeros
    const pos = await svc.position(ctx);
    expect(pos).toEqual({ arOutstanding: 0, apOutstanding: 0, netForecast: 0, workingCapitalGap: 0 });
  });

  it('exportCsv pulls up to 200 rows and emits a header + a line per row', async () => {
    const { svc, repo } = make({
      list: jest.fn(async () => ({ rows: [forecast(), forecast({ cfId: 8, direction: 'OUTFLOW' })], total: 2, page: 1, pageSize: 200 })),
    });
    const csv = await svc.exportCsv(ctx, { page: 1, pageSize: 25 });
    expect(repo.list).toHaveBeenCalledWith(ctx, expect.objectContaining({ pageSize: 200 }));
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Direction');
    expect(lines).toHaveLength(3); // header + 2 rows
  });
});
