import { InstallationStatus, SatResult, PunchStatus } from './installation.constants';

/** A SAT / commissioning punch-list defect (camelCase projection of qms.punch_item). */
export interface PunchItem {
  punchId?: number;
  description: string;
  severity: string | null;
  status: PunchStatus;
  closedDate: string | null;
}

/** A persisted installation row (camelCase projection of svc.installation). */
export interface Installation {
  installId: number;
  installNo: string;
  companyId: number;
  buId: number | null;
  projectId: number;
  dispatchId: number | null;
  siteAddress: string | null;
  siteEngineerId: number | null;
  progressPct: number | null;
  plannedDate: string | null;
  actualDate: string | null;
  satResult: SatResult;
  acceptanceCertNo: string | null;
  acceptedDate: string | null;
  status: InstallationStatus;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  punchItems: PunchItem[];
}

export interface InstallationListResult {
  rows: Omit<Installation, 'punchItems'>[];
  total: number;
  page: number;
  pageSize: number;
}
