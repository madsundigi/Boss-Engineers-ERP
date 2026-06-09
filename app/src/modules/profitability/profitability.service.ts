import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import {
  ProfitabilityRepository, ProjectFinancials, SnapshotInput,
} from './profitability.repository';
import {
  MarginSnapshot, MarginSnapshotListResult, PortfolioMarginRow, ProjectPnl,
} from './profitability.types';
import { ComputeSnapshotDto, ListQueryDto } from './profitability.dto';
import { MARGIN_SNAPSHOT_CREATED_EVENT } from './profitability.constants';

/** Round a numeric to 4 dp (matches numeric(9,4) for the indices), guarding NaN. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Gross margin % = (revenue - actualCost) / revenue * 100; null when no revenue. */
export function marginPct(revenue: number, actualCost: number): number | null {
  if (revenue <= 0) return null;
  return round4(((revenue - actualCost) / revenue) * 100);
}

/**
 * Cost Performance Index = budgetCost / actualCost (earned-value style: >1 means
 * spending under budget for the work done). Null when no actual cost is incurred
 * yet (division by zero).
 */
export function costPerformanceIndex(budgetCost: number, actualCost: number): number | null {
  if (actualCost <= 0) return null;
  return round4(budgetCost / actualCost);
}

/**
 * Estimate At Completion (EAC), a simple "actuals + remaining commitments" basis:
 * EAC = actualCost + GREATEST(committedCost - actualCost, 0). Once actuals exceed
 * the commitments, the remaining-commitment term floors at 0 so EAC tracks actuals.
 */
export function forecastEac(committedCost: number, actualCost: number): number {
  return round4(actualCost + Math.max(committedCost - actualCost, 0));
}

/**
 * ProfitabilityService — business logic for the Project Profitability & Margin
 * Analysis module (M15). Stateless; depends only on the repository (injected) so
 * it is unit-testable without a database. The margin-snapshot log is append-only:
 * computeSnapshot records a new immutable snapshot (latest wins) and emits
 * 'margin.snapshot.created' atomically with the insert. There is no update/delete.
 */
export class ProfitabilityService {
  constructor(private readonly repo: ProfitabilityRepository) {}

  /**
   * Aggregate the project's revenue + costs, derive the margin/CPI/EAC indices,
   * and append one immutable snapshot. SPI is left null here — this module has no
   * schedule baseline (planned vs earned value) to compute a Schedule Performance
   * Index, so the column is reserved for a future scheduling integration.
   */
  async computeSnapshot(ctx: RequestContext, dto: ComputeSnapshotDto): Promise<MarginSnapshot> {
    const project = await this.repo.findProject(ctx, dto.projectId);
    if (!project) throw Errors.notFound(`Project ${dto.projectId} not found`);

    const fin = await this.repo.aggregateFinancials(ctx, dto.projectId);
    const input = this.deriveSnapshot(dto.projectId, fin);
    const event = this.snapshotEvent(ctx, input);
    return this.repo.insert(ctx, input, event);
  }

  /** Pure derivation of the snapshot row from the aggregated financials. */
  private deriveSnapshot(projectId: number, fin: ProjectFinancials): SnapshotInput {
    return {
      projectId,
      revenue: fin.revenue,
      committedCost: fin.committedCost,
      actualCost: fin.actualCost,
      forecastCostEac: forecastEac(fin.committedCost, fin.actualCost),
      marginPct: marginPct(fin.revenue, fin.actualCost),
      cpi: costPerformanceIndex(fin.budgetCost, fin.actualCost),
      spi: null, // no schedule baseline in this module — reserved.
    };
  }

  /** Build the transactional-outbox event recorded with every snapshot. */
  private snapshotEvent(ctx: RequestContext, s: SnapshotInput): OutboxEventInput {
    return {
      eventType: MARGIN_SNAPSHOT_CREATED_EVENT,
      aggregateType: 'MARGIN_SNAPSHOT',
      aggregateId: s.projectId,
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        projectId: s.projectId,
        revenue: s.revenue,
        actualCost: s.actualCost,
        marginPct: s.marginPct,
      },
    };
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<MarginSnapshotListResult> {
    return this.repo.list(ctx, query);
  }

  async getLatestForProject(ctx: RequestContext, projectId: number): Promise<MarginSnapshot> {
    const row = await this.repo.findLatestForProject(ctx, projectId);
    if (!row) throw Errors.notFound(`No margin snapshot found for project ${projectId}`);
    return row;
  }

  /**
   * The latest snapshot for a project expanded into a P&L shape (404 if none),
   * enriched with the project's cost broken down by CATEGORY (cost_type) read live
   * from the ledger — Material / Labour / Freight / Installation / Warranty / …
   */
  async projectPnl(ctx: RequestContext, projectId: number): Promise<ProjectPnl> {
    const s = await this.getLatestForProject(ctx, projectId);
    const costByCategory = await this.repo.costByCategory(ctx, projectId);
    return {
      projectId: s.projectId,
      snapshotId: s.snapshotId,
      snapshotDate: s.snapshotDate,
      revenue: s.revenue,
      committedCost: s.committedCost,
      actualCost: s.actualCost,
      forecastCostEac: s.forecastCostEac,
      grossMargin: round4(s.revenue - s.actualCost),
      marginPct: s.marginPct,
      cpi: s.cpi,
      spi: s.spi,
      costByCategory,
    };
  }

  /** Management portfolio view: one row per project (its latest snapshot). */
  portfolioMargin(ctx: RequestContext): Promise<PortfolioMarginRow[]> {
    return this.repo.portfolioMargin(ctx);
  }

  /** PROFITABILITY.EXPORT — CSV of the (filtered) snapshot list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Snapshot Id', 'Project', 'Snapshot Date', 'Revenue', 'Committed Cost',
      'Actual Cost', 'Forecast Cost (EAC)', 'Margin %', 'CPI', 'SPI'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.snapshotId, r.projectId, r.snapshotDate, r.revenue, r.committedCost,
      r.actualCost, r.forecastCostEac, r.marginPct, r.cpi, r.spi,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
