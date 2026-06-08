import { RiskStatus, RiskCategory, SeverityBand } from './risk.constants';

/**
 * A persisted project risk (camelCase projection of proj.project_risk, created in
 * migration 031). severity is the database-computed product likelihood * impact.
 */
export interface Risk {
  riskId: number;
  companyId: number;
  buId: number | null;
  projectId: number;
  title: string;
  description: string | null;
  category: RiskCategory | null;
  likelihood: number;
  impact: number;
  severity: number;
  mitigation: string | null;
  ownerId: number | null;
  dueDate: string | null;
  status: RiskStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface RiskListResult {
  rows: Risk[];
  total: number;
  page: number;
  pageSize: number;
}

/** One row of the severity-band heatmap / summary read (grouped count). */
export interface RiskHeatmapRow {
  band: SeverityBand;
  count: number;
}
