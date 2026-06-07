import { ChangeStatus } from './change.constants';

/**
 * A persisted change-order row (camelCase projection of proj.change_order).
 * Header-only: a scope/engineering variation with its cost / price (revenue) /
 * schedule impact and an optional reason captured at submit / reject time.
 */
export interface ChangeOrder {
  changeOrderId: number;
  changeNo: string;
  companyId: number;
  buId: number | null;
  projectId: number;
  description: string;
  reason: string | null;
  costImpact: number;
  priceImpact: number;
  scheduleImpactDays: number;
  status: ChangeStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  updatedBy: number | null;
  rowVersion: number;
}

export interface ChangeOrderListResult {
  rows: ChangeOrder[];
  total: number;
  page: number;
  pageSize: number;
}
