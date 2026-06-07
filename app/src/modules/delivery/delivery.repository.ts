import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead } from '../../db/pool';
import { emitOutbox, OutboxEventInput } from '../../outbox/outbox';
import { RequestContext } from '../../common/request-context';
import { DeliveryForecast, DeliveryForecastListResult } from './delivery.types';
import { ListQueryDto } from './delivery.dto';

// Columns of proj.delivery_forecast (company_id added in migration 017 for RLS).
// delay_days is a GENERATED column (predicted_delivery - committed_delivery): it is
// SELECT-ed here but MUST NOT appear in any INSERT/UPDATE column list.
const COLS = `forecast_id, project_id, forecast_date, predicted_delivery,
  committed_delivery, delay_days, risk_level, driver, created_at, created_by`;

function mapForecast(r: QueryResultRow): DeliveryForecast {
  return {
    forecastId: Number(r.forecast_id),
    projectId: Number(r.project_id),
    forecastDate: r.forecast_date,
    predictedDelivery: r.predicted_delivery,
    committedDelivery: r.committed_delivery,
    delayDays: r.delay_days == null ? null : Number(r.delay_days),
    riskLevel: r.risk_level,
    driver: r.driver,
    createdAt: r.created_at,
    createdBy: r.created_by == null ? null : Number(r.created_by),
  };
}

/** Fields accepted by an append (delay_days excluded — it is generated). */
export interface ForecastInput {
  projectId: number;
  forecastDate?: string;
  predictedDelivery: string;
  committedDelivery?: string;
  riskLevel?: string;
  driver?: string;
}

export class DeliveryRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Append a new immutable forecast snapshot. company_id = ctx.companyId so the
   * row satisfies the per-company RLS policy. Optionally emits an outbox event
   * (e.g. 'delivery.at_risk' on a HIGH-risk forecast) atomically with the insert
   * (transactional outbox). No optimistic concurrency — the table is append-only.
   */
  async insert(
    ctx: RequestContext, f: ForecastInput, event?: OutboxEventInput,
  ): Promise<DeliveryForecast> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO proj.delivery_forecast
           (company_id, project_id, forecast_date, predicted_delivery,
            committed_delivery, risk_level, driver, created_by)
         VALUES ($1, $2, COALESCE($3::date, current_date), $4, $5, $6, $7, $8)
         RETURNING ${COLS}`,
        [
          ctx.companyId, f.projectId, f.forecastDate ?? null, f.predictedDelivery,
          f.committedDelivery ?? null, f.riskLevel ?? null, f.driver ?? null, ctx.userId,
        ]);
      const row = mapForecast(res.rows[0]);
      // Atomic with the insert: record the domain event (transactional outbox).
      if (event) await emitOutbox(c, event);
      return row;
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<DeliveryForecastListResult> {
    const where: string[] = ['company_id = $1'];
    const params: unknown[] = [ctx.companyId];
    if (q.projectId) { params.push(q.projectId); where.push(`project_id = $${params.length}`); }
    if (q.riskLevel) { params.push(q.riskLevel); where.push(`risk_level = $${params.length}`); }
    const w = where.join(' AND ');
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM proj.delivery_forecast WHERE ${w}`, params)).rows[0].c);
      // Newest first: forecast_date then forecast_id (snapshot order).
      const rows = await c.query(
        `SELECT ${COLS} FROM proj.delivery_forecast WHERE ${w}
          ORDER BY forecast_date DESC, forecast_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapForecast), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /** Most recent forecast for a project (by forecast_date, then forecast_id). */
  async findLatestForProject(ctx: RequestContext, projectId: number): Promise<DeliveryForecast | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${COLS} FROM proj.delivery_forecast
          WHERE company_id = $1 AND project_id = $2
          ORDER BY forecast_date DESC, forecast_id DESC LIMIT 1`,
        [ctx.companyId, projectId]);
      return res.rowCount ? mapForecast(res.rows[0]) : null;
    });
  }
}
