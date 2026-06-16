import { DashboardService, DashboardRepoLike } from '../src/modules/dashboard/dashboard.service';
import { KpiParts } from '../src/modules/dashboard/dashboard.repository';
import { RequestContext } from '../src/common/request-context';
import { FunnelRow, TrendRow } from '../src/modules/dashboard/dashboard.types';

const ctx: RequestContext = {
  userId: 5, username: 'ceo', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

/** A fully-populated, non-trivial set of KPI parts (the repo's output shape). */
function parts(over: Partial<KpiParts> = {}): KpiParts {
  return {
    salesPipeline: {
      openEnquiries: 4, openEnquiryValue: 1000,
      openQuotations: 3, openQuotationValue: 7500,
    },
    activeProjects: { count: 6, orderBook: 250000 },
    wipWorkOrders: 11,
    dispatchesMtd: 2,
    arOutstanding: 42000,
    apOutstanding: 18000,
    openNcrs: 5,
    avgMarginPct: 21.5,
    deliveryAtRisk: 1,
    criticalItems: 3,
    revenue: 525000,
    fatPassRate: 92.5,
    productionEfficiency: 80,
    openServiceTickets: 4,
    ...over,
  };
}

/** All-zero parts — what the repository returns for a brand-new / empty company. */
function zeroParts(): KpiParts {
  return {
    salesPipeline: {
      openEnquiries: 0, openEnquiryValue: 0, openQuotations: 0, openQuotationValue: 0,
    },
    activeProjects: { count: 0, orderBook: 0 },
    wipWorkOrders: 0, dispatchesMtd: 0, arOutstanding: 0, apOutstanding: 0,
    openNcrs: 0, avgMarginPct: 0, deliveryAtRisk: 0, criticalItems: 0,
    revenue: 0, fatPassRate: 0, productionEfficiency: 0, openServiceTickets: 0,
  };
}

function makeRepo(): jest.Mocked<DashboardRepoLike> {
  return {
    fetchKpiParts: jest.fn(),
    fetchSalesFunnel: jest.fn(),
    fetchTrends: jest.fn(),
  } as unknown as jest.Mocked<DashboardRepoLike>;
}

// Every numeric KPI key the summary must always expose.
const SCALAR_KEYS = [
  'activeProjects', 'orderBook', 'wipWorkOrders', 'dispatchesMtd',
  'arOutstanding', 'apOutstanding', 'openNcrs', 'avgMarginPct', 'deliveryAtRisk',
  'criticalItems', 'revenue', 'fatPassRate', 'productionEfficiency', 'openServiceTickets',
] as const;

describe('DashboardService', () => {
  let repo: jest.Mocked<DashboardRepoLike>;
  let service: DashboardService;
  beforeEach(() => { repo = makeRepo(); service = new DashboardService(repo); });

  describe('getKpiSummary', () => {
    it('maps every repo KPI part into the flat summary object', async () => {
      repo.fetchKpiParts.mockResolvedValue(parts());
      const k = await service.getKpiSummary(ctx);

      expect(repo.fetchKpiParts).toHaveBeenCalledWith(ctx);
      // nested pipeline preserved verbatim
      expect(k.salesPipeline).toEqual({
        openEnquiries: 4, openEnquiryValue: 1000,
        openQuotations: 3, openQuotationValue: 7500,
      });
      // activeProjects part is split into the count + order book scalars
      expect(k.activeProjects).toBe(6);
      expect(k.orderBook).toBe(250000);
      expect(k.wipWorkOrders).toBe(11);
      expect(k.dispatchesMtd).toBe(2);
      expect(k.arOutstanding).toBe(42000);
      expect(k.apOutstanding).toBe(18000);
      expect(k.openNcrs).toBe(5);
      expect(k.avgMarginPct).toBe(21.5);
      expect(k.deliveryAtRisk).toBe(1);
      expect(k.criticalItems).toBe(3);
      expect(k.revenue).toBe(525000);
      expect(k.fatPassRate).toBe(92.5);
      expect(k.productionEfficiency).toBe(80);
      expect(k.openServiceTickets).toBe(4);
    });

    it('always returns every numeric KPI key as a number', async () => {
      repo.fetchKpiParts.mockResolvedValue(parts());
      const k = await service.getKpiSummary(ctx) as unknown as Record<string, unknown>;
      for (const key of SCALAR_KEYS) {
        expect(typeof k[key]).toBe('number');
      }
      const sp = k.salesPipeline as Record<string, unknown>;
      for (const key of ['openEnquiries', 'openEnquiryValue', 'openQuotations', 'openQuotationValue']) {
        expect(typeof sp[key]).toBe('number');
      }
    });

    it('returns a fully-populated all-zero object for an empty company (never throws)', async () => {
      repo.fetchKpiParts.mockResolvedValue(zeroParts());
      const k = await service.getKpiSummary(ctx) as unknown as Record<string, unknown>;
      for (const key of SCALAR_KEYS) {
        expect(k[key]).toBe(0);
      }
      expect(k.salesPipeline).toEqual({
        openEnquiries: 0, openEnquiryValue: 0, openQuotations: 0, openQuotationValue: 0,
      });
    });
  });

  describe('getSalesFunnel', () => {
    it('passes the funnel straight through from the repo', async () => {
      const funnel: FunnelRow[] = [
        { stage: 'ENQUIRY', count: 10 },
        { stage: 'QUOTATION', count: 6 },
        { stage: 'WON', count: 2 },
        { stage: 'PROJECT', count: 2 },
      ];
      repo.fetchSalesFunnel.mockResolvedValue(funnel);
      const out = await service.getSalesFunnel(ctx);
      expect(out).toBe(funnel);
      expect(repo.fetchSalesFunnel).toHaveBeenCalledWith(ctx);
    });
  });

  describe('getTrends', () => {
    it('passes the 6-month trend series straight through from the repo', async () => {
      const trends: TrendRow[] = [
        { month: '2026-01', label: 'Jan', enquiries: 3, quotations: 1, revenue: 0 },
        { month: '2026-02', label: 'Feb', enquiries: 0, quotations: 0, revenue: 0 },
        { month: '2026-03', label: 'Mar', enquiries: 5, quotations: 4, revenue: 120000 },
        { month: '2026-04', label: 'Apr', enquiries: 2, quotations: 2, revenue: 0 },
        { month: '2026-05', label: 'May', enquiries: 1, quotations: 0, revenue: 50000 },
        { month: '2026-06', label: 'Jun', enquiries: 4, quotations: 3, revenue: 90000 },
      ];
      repo.fetchTrends.mockResolvedValue(trends);
      const out = await service.getTrends(ctx);
      expect(out).toBe(trends);
      expect(repo.fetchTrends).toHaveBeenCalledWith(ctx);
    });
  });

  describe('exportKpisCsv', () => {
    it('flattens the summary into a Metric,Value CSV with a header + every KPI row', async () => {
      repo.fetchKpiParts.mockResolvedValue(parts());
      const csv = await service.exportKpisCsv(ctx);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('Metric,Value');
      // header + 4 pipeline rows + 14 scalar rows = 19 lines
      expect(lines).toHaveLength(19);
      expect(csv).toContain('"activeProjects","6"');
      expect(csv).toContain('"orderBook","250000"');
      expect(csv).toContain('"salesPipeline.openQuotationValue","7500"');
      expect(csv).toContain('"avgMarginPct","21.5"');
      expect(csv).toContain('"revenue","525000"');
      expect(csv).toContain('"fatPassRate","92.5"');
      expect(csv).toContain('"productionEfficiency","80"');
      expect(csv).toContain('"openServiceTickets","4"');
    });

    it('still produces a complete CSV (all zeros) for an empty company', async () => {
      repo.fetchKpiParts.mockResolvedValue(zeroParts());
      const csv = await service.exportKpisCsv(ctx);
      expect(csv.split('\n')).toHaveLength(19);
      expect(csv).toContain('"deliveryAtRisk","0"');
    });
  });
});
