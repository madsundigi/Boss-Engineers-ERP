import { RequestContext } from '../../common/request-context';
import { DashboardRepository } from './dashboard.repository';
import { KpiSummary, FunnelRow } from './dashboard.types';

/** Repository surface the service depends on (lets the unit test inject a fake). */
export type DashboardRepoLike = Pick<
  DashboardRepository, 'fetchKpiParts' | 'fetchSalesFunnel'
>;

/**
 * DashboardService — assembles the M16 management KPI object (read-only). It is a thin,
 * stateless mapper over the repository: it folds the repo's KPI parts into the public
 * KpiSummary shape and never writes, never emits events. Because the repository already
 * COALESCEs every aggregate to 0, the service maps cleanly for an empty company — it
 * always returns a fully-populated object of numbers and never throws on no data.
 */
export class DashboardService {
  constructor(private readonly repo: DashboardRepoLike) {}

  /** Build the single KPI summary object for GET /api/dashboard/kpis. */
  async getKpiSummary(ctx: RequestContext): Promise<KpiSummary> {
    const p = await this.repo.fetchKpiParts(ctx);
    return {
      salesPipeline: {
        openEnquiries: p.salesPipeline.openEnquiries,
        openEnquiryValue: p.salesPipeline.openEnquiryValue,
        openQuotations: p.salesPipeline.openQuotations,
        openQuotationValue: p.salesPipeline.openQuotationValue,
      },
      activeProjects: p.activeProjects.count,
      orderBook: p.activeProjects.orderBook,
      wipWorkOrders: p.wipWorkOrders,
      dispatchesMtd: p.dispatchesMtd,
      arOutstanding: p.arOutstanding,
      apOutstanding: p.apOutstanding,
      openNcrs: p.openNcrs,
      avgMarginPct: p.avgMarginPct,
      deliveryAtRisk: p.deliveryAtRisk,
    };
  }

  /** Sales funnel stage counts for GET /api/dashboard/sales-funnel. */
  getSalesFunnel(ctx: RequestContext): Promise<FunnelRow[]> {
    return this.repo.fetchSalesFunnel(ctx);
  }

  /**
   * DASHBOARD.EXPORT — flatten the KPI summary into a two-column (Metric,Value) CSV.
   * Nested salesPipeline fields are emitted as dotted keys so the export is a flat
   * scalar table suitable for a spreadsheet.
   */
  async exportKpisCsv(ctx: RequestContext): Promise<string> {
    const k = await this.getKpiSummary(ctx);
    const rows: Array<[string, number]> = [
      ['salesPipeline.openEnquiries', k.salesPipeline.openEnquiries],
      ['salesPipeline.openEnquiryValue', k.salesPipeline.openEnquiryValue],
      ['salesPipeline.openQuotations', k.salesPipeline.openQuotations],
      ['salesPipeline.openQuotationValue', k.salesPipeline.openQuotationValue],
      ['activeProjects', k.activeProjects],
      ['orderBook', k.orderBook],
      ['wipWorkOrders', k.wipWorkOrders],
      ['dispatchesMtd', k.dispatchesMtd],
      ['arOutstanding', k.arOutstanding],
      ['apOutstanding', k.apOutstanding],
      ['openNcrs', k.openNcrs],
      ['avgMarginPct', k.avgMarginPct],
      ['deliveryAtRisk', k.deliveryAtRisk],
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map(([metric, value]) => `${esc(metric)},${esc(value)}`);
    return ['Metric,Value', ...lines].join('\n');
  }
}
