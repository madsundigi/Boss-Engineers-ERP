import { RiskLevel, Driver, RiskRag, RiskDriver } from './delivery.constants';

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

/**
 * Raw upstream delay signals for one project (the flowchart's three INPUTS):
 *   overduePurchaseOrders  — Purchase Delays   (scm.purchase_order),
 *   delayedWorkOrders      — Production Delays  (mfg.work_order),
 *   pendingOrFailedFats    — Resource/FAT Delays (qms.fat_execution).
 * Counts are company- and project-scoped; never negative.
 */
export interface DeliveryRiskSignals {
  overduePurchaseOrders: number;
  delayedWorkOrders: number;
  pendingOrFailedFats: number;
}

/**
 * Derived delivery-risk for a project: the flowchart's Green/Yellow/Red OUTPUT
 * plus the leading driver and the raw signals it was computed from. driver is
 * null exactly when riskLevel is GREEN. asOf is the server timestamp the signals
 * were read (CURRENT_DATE is the cut-off for "overdue").
 */
export interface DeliveryRiskResult {
  projectId: number;
  riskLevel: RiskRag;
  driver: RiskDriver | null;
  signals: DeliveryRiskSignals;
  asOf: string;
}
