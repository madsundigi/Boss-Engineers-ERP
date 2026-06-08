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
