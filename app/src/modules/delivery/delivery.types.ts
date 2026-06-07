import { RiskLevel, Driver } from './delivery.constants';

/**
 * A persisted forecast snapshot (camelCase projection of proj.delivery_forecast).
 * Append-only: no rowVersion, no status, no soft-delete. delayDays is a generated
 * column (predicted_delivery - committed_delivery) — read-only, never written.
 */
export interface DeliveryForecast {
  forecastId: number;
  projectId: number;
  forecastDate: string;
  predictedDelivery: string;
  committedDelivery: string | null;
  delayDays: number | null;
  riskLevel: RiskLevel | null;
  driver: Driver | null;
  createdAt: string;
  createdBy: number | null;
}

export interface DeliveryForecastListResult {
  rows: DeliveryForecast[];
  total: number;
  page: number;
  pageSize: number;
}
