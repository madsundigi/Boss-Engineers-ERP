import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { OutboxEventInput } from '../../outbox/outbox';
import { DeliveryRepository, ForecastInput } from './delivery.repository';
import { DeliveryForecast, DeliveryForecastListResult } from './delivery.types';
import { CreateForecastDto, ListQueryDto } from './delivery.dto';
import { DELIVERY_AT_RISK_EVENT } from './delivery.constants';

/**
 * DeliveryService — business logic for the Delivery Prediction module (M09).
 * Stateless; depends only on the repository (injected) so it is unit-testable
 * without a database. The forecast log is append-only: createForecast records a
 * new immutable snapshot (a "revision" is just a newer row, latest wins) and there
 * is no update or delete. A HIGH-risk forecast emits 'delivery.at_risk' atomically
 * with the insert so downstream consumers can flag the project.
 */
export class DeliveryService {
  constructor(private readonly repo: DeliveryRepository) {}

  async createForecast(ctx: RequestContext, dto: CreateForecastDto): Promise<DeliveryForecast> {
    const input: ForecastInput = {
      projectId: dto.projectId,
      forecastDate: dto.forecastDate,
      predictedDelivery: dto.predictedDelivery,
      committedDelivery: dto.committedDelivery,
      riskLevel: dto.riskLevel,
      driver: dto.driver,
    };
    // Only a HIGH-risk slip raises the at-risk alert (LOW/MEDIUM stay silent).
    const event = dto.riskLevel === 'HIGH'
      ? this.atRiskEvent(ctx, dto)
      : undefined;
    return this.repo.insert(ctx, input, event);
  }

  /** Build the transactional-outbox event for a HIGH-risk forecast. */
  private atRiskEvent(ctx: RequestContext, dto: CreateForecastDto): OutboxEventInput {
    return {
      eventType: DELIVERY_AT_RISK_EVENT,
      aggregateType: 'DELIVERY_FORECAST',
      aggregateId: dto.projectId,
      companyId: ctx.companyId,
      createdBy: ctx.userId,
      payload: {
        projectId: dto.projectId,
        predictedDelivery: dto.predictedDelivery,
        committedDelivery: dto.committedDelivery ?? null,
        // delay_days is DB-generated; surface it from predicted - committed when both known.
        delayDays: this.delayDays(dto),
        driver: dto.driver ?? null,
      },
    };
  }

  /** Days predicted slips past the commitment (>0 = late). Null if no commitment. */
  private delayDays(dto: CreateForecastDto): number | null {
    if (!dto.committedDelivery) return null;
    const ms = Date.parse(dto.predictedDelivery) - Date.parse(dto.committedDelivery);
    return Math.round(ms / 86_400_000);
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<DeliveryForecastListResult> {
    return this.repo.list(ctx, query);
  }

  async getLatestForProject(ctx: RequestContext, projectId: number): Promise<DeliveryForecast> {
    const row = await this.repo.findLatestForProject(ctx, projectId);
    if (!row) throw Errors.notFound(`No delivery forecast found for project ${projectId}`);
    return row;
  }

  /** DELIVERY_FORECAST.EXPORT — CSV of the (filtered) forecast list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = ['Forecast Id', 'Project', 'Forecast Date', 'Predicted Delivery',
      'Committed Delivery', 'Delay Days', 'Risk Level', 'Driver', 'Created'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.forecastId, r.projectId, r.forecastDate, r.predictedDelivery,
      r.committedDelivery, r.delayDays, r.riskLevel, r.driver, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
