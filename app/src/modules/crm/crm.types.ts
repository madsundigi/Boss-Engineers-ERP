import { OpportunityStage, ActivityType, ActivityStatus } from './crm.constants';

/**
 * A persisted sales opportunity (camelCase projection of crm.opportunity, created
 * in migration 039).
 */
export interface Opportunity {
  oppId: number;
  oppNo: string;
  companyId: number;
  buId: number | null;
  customerId: number;
  enquiryId: number | null;
  title: string;
  stage: OpportunityStage;
  estValue: number;
  probabilityPct: number;
  expectedCloseDate: string | null;
  ownerId: number | null;
  lostReason: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface OpportunityListResult {
  rows: Opportunity[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One row of the pipeline summary read: the count + total estimated value of the
 * (open + closed) opportunities in a given stage.
 */
export interface PipelineStageSummary {
  stage: OpportunityStage;
  count: number;
  totalEstValue: number;
}

/**
 * A persisted follow-up activity (camelCase projection of crm.activity). Linked to
 * an opportunity and/or a customer.
 */
export interface Activity {
  activityId: number;
  companyId: number;
  oppId: number | null;
  customerId: number | null;
  activityType: ActivityType;
  subject: string;
  dueDate: string | null;
  completedAt: string | null;
  status: ActivityStatus;
  ownerId: number | null;
  notes: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface ActivityListResult {
  rows: Activity[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One open-stage row of the revenue forecast: the count, the gross (Σ est_value) and
 * the probability-weighted (Σ est_value * probability_pct/100) value of the OPEN
 * opportunities sitting in that stage.
 */
export interface ForecastStageRow {
  stage: OpportunityStage;
  count: number;
  gross: number;
  weighted: number;
}

/**
 * One month bucket of the revenue forecast, grouped on expected_close_date. `month` is
 * 'YYYY-MM', or the literal 'unscheduled' for OPEN opportunities with no close date.
 */
export interface ForecastMonthRow {
  month: string; // 'YYYY-MM' | 'unscheduled'
  count: number;
  gross: number;
  weighted: number;
}

/**
 * Revenue Forecasting read (weighted sales pipeline). The Quotation / Sales flow
 * "pushes to Revenue Forecasting": this aggregates the OPEN opportunity pipeline
 * (stage NOT IN WON, LOST) into a probability-weighted commit number, with the gross
 * open value, the closed-won total, and per-stage / per-close-month breakdowns.
 * Company-scoped; all sums are 0 / arrays empty for a company with no opportunities.
 */
export interface RevenueForecast {
  weightedTotal: number;  // Σ est_value * probability_pct/100 over OPEN opps
  grossOpenTotal: number; // Σ est_value over OPEN opps
  wonTotal: number;       // Σ est_value where stage = WON
  byStage: ForecastStageRow[];
  byMonth: ForecastMonthRow[];
}

/**
 * The customer-360 read: the customer's opportunities grouped by stage (count + est
 * value), their open (PENDING) activities, and counts of their enquiries / quotations
 * for a quick relationship overview.
 */
export interface Customer360 {
  customerId: number;
  pipeline: PipelineStageSummary[];
  openActivities: Activity[];
  enquiryCount: number;
  quotationCount: number;
  openOpportunityCount: number;
  wonOpportunityCount: number;
}
