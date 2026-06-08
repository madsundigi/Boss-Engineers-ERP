import { IncidentType, IncidentSeverity, IncidentStatus } from './ehs.constants';

/**
 * A persisted EHS incident (camelCase projection of ehs.incident, created in
 * migration 035). incident_no is the branch-scoped document number (prefix 'INC').
 */
export interface Incident {
  incidentId: number;
  companyId: number;
  buId: number | null;
  incidentNo: string;
  incidentDate: string;
  incidentType: IncidentType;
  severity: IncidentSeverity;
  location: string | null;
  projectId: number | null;
  description: string;
  correctiveAction: string | null;
  status: IncidentStatus;
  reportedBy: number | null;
  closedAt: string | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
}

export interface IncidentListResult {
  rows: Incident[];
  total: number;
  page: number;
  pageSize: number;
}
