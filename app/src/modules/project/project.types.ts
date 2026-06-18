import { HealthRag, ProjectStatus } from './project.constants';

/** A persisted project row (camelCase projection of proj.project). */
export interface Project {
  projectId: number;
  projectNo: string;
  companyId: number;
  buId: number | null;
  projectName: string;
  customerId: number;
  quotationId: number | null;
  enquiryId: number | null;
  contractValue: number;
  budgetCost: number;
  pmUserId: number;
  plannedStart: string | null;
  plannedEnd: string | null;
  contractualEnd: string | null;
  ldPctPerWeek: number | null;
  status: ProjectStatus;
  healthRag: HealthRag | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface ProjectListResult {
  rows: Project[];
  total: number;
  page: number;
  pageSize: number;
}
