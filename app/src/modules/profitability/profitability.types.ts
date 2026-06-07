/**
 * A persisted margin snapshot (camelCase projection of fin.margin_snapshot).
 * Append-only: no rowVersion, no status, no soft-delete. revenue/costs are
 * numeric(20,4); the indices (marginPct/cpi/spi) are numeric(9,4) and nullable.
 */
export interface MarginSnapshot {
  snapshotId: number;
  projectId: number;
  snapshotDate: string;
  revenue: number;
  committedCost: number;
  actualCost: number;
  forecastCostEac: number;
  marginPct: number | null;
  cpi: number | null;
  spi: number | null;
}

export interface MarginSnapshotListResult {
  rows: MarginSnapshot[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The latest snapshot expanded into a P&L shape for a single project. budgetCost
 * is re-derived from the ledger at read time (the snapshot stores committed/actual
 * but not budget); grossMargin = revenue - actualCost.
 */
export interface ProjectPnl {
  projectId: number;
  snapshotId: number;
  snapshotDate: string;
  revenue: number;
  committedCost: number;
  actualCost: number;
  forecastCostEac: number;
  grossMargin: number;
  marginPct: number | null;
  cpi: number | null;
  spi: number | null;
}

/**
 * One row per project for the management portfolio view: the project's latest
 * snapshot's headline figures (revenue, actualCost, marginPct). Projects with no
 * snapshot yet are omitted.
 */
export interface PortfolioMarginRow {
  projectId: number;
  snapshotId: number;
  snapshotDate: string;
  revenue: number;
  actualCost: number;
  marginPct: number | null;
}
