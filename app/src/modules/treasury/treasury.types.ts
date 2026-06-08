import { CashflowDirection, CashflowCategory } from './treasury.constants';

/**
 * A persisted cash-flow forecast entry (camelCase projection of
 * fin.cashflow_forecast, created in migration 034). Append-only: no rowVersion,
 * no status, no soft-delete.
 */
export interface CashflowForecast {
  cfId: number;
  companyId: number;
  buId: number | null;
  forecastDate: string;
  periodLabel: string | null;
  direction: CashflowDirection;
  category: CashflowCategory | null;
  amount: number;
  projectId: number | null;
  note: string | null;
  createdAt: string;
  createdBy: number | null;
}

export interface CashflowForecastListResult {
  rows: CashflowForecast[];
  total: number;
  page: number;
  pageSize: number;
}

/** One row of the forecast summary read: net cash for a period (inflow - outflow). */
export interface CashflowSummaryRow {
  periodLabel: string | null;
  inflow: number;
  outflow: number;
  net: number;
}

/**
 * Working-capital position snapshot — a point-in-time read combining the live AR / AP
 * ledgers with the cash-flow forecast. All values are floats (numeric cast), never null.
 */
export interface WorkingCapitalPosition {
  arOutstanding: number;
  apOutstanding: number;
  netForecast: number;
  workingCapitalGap: number;
}
