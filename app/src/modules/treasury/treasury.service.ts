import { RequestContext } from '../../common/request-context';
import { TreasuryRepository, ForecastInput } from './treasury.repository';
import {
  CashflowForecast, CashflowForecastListResult, CashflowSummaryRow, WorkingCapitalPosition,
} from './treasury.types';
import { CreateForecastDto, ListQueryDto } from './treasury.dto';

/**
 * TreasuryService — business logic for the Treasury / Cash-flow module (M-Treasury).
 * Stateless; depends only on the repository (injected) so it is unit-testable without
 * a database. The forecast log is append-only: addForecast records a new immutable row
 * (a "correction" is a newer offsetting row, never an edit) and there is no update or
 * delete path. forecastSummary nets inflow vs outflow by period; position assembles a
 * working-capital snapshot over the live AR / AP ledgers plus the forecast.
 */
export class TreasuryService {
  constructor(private readonly repo: TreasuryRepository) {}

  addForecast(ctx: RequestContext, dto: CreateForecastDto): Promise<CashflowForecast> {
    const input: ForecastInput = {
      forecastDate: dto.forecastDate,
      periodLabel: dto.periodLabel,
      direction: dto.direction,
      category: dto.category,
      amount: dto.amount,
      projectId: dto.projectId,
      note: dto.note,
    };
    return this.repo.insert(ctx, input);
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<CashflowForecastListResult> {
    return this.repo.list(ctx, query);
  }

  /** Net cash by period_label (inflow - outflow), optionally scoped to one project. */
  forecastSummary(ctx: RequestContext, projectId?: number): Promise<CashflowSummaryRow[]> {
    return this.repo.summary(ctx, projectId);
  }

  /** Working-capital snapshot: AR outstanding, AP outstanding, net forecast, gap. */
  position(ctx: RequestContext): Promise<WorkingCapitalPosition> {
    return this.repo.position(ctx);
  }

  /** TREASURY.EXPORT — CSV of the (filtered) forecast list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Cf Id', 'Forecast Date', 'Period', 'Direction', 'Category',
      'Amount', 'Project', 'Note', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.cfId, r.forecastDate, r.periodLabel, r.direction, r.category,
      r.amount, r.projectId, r.note, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
