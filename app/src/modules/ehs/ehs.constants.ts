/** Domain constants for the EHS / Incident Register module (Tier-3 value-add).
 *
 * An EHS incident: a reported Environment-Health-Safety event — an INJURY, NEARMISS,
 * SPILL, FIRE, PROPERTY-damage or OTHER occurrence — logged at a location (optionally
 * against a project), triaged by severity, then investigated and signed off (closed)
 * with a corrective action. Anyone on the shop floor can REPORT; QC owns the
 * investigation + closure. There is NO base table for it — migration 035 CREATES the
 * new 'ehs' schema + ehs.incident and seeds the 'EHS' RBAC domain (absent from the
 * db/08 catalog), with a branch-scoped 'INCIDENT' document number (prefix 'INC').
 */

/** Incident type (ehs.incident.incident_type). Mirrors the CHECK in migration 035. */
export const INCIDENT_TYPE = ['INJURY', 'NEARMISS', 'SPILL', 'FIRE', 'PROPERTY', 'OTHER'] as const;
export type IncidentType = (typeof INCIDENT_TYPE)[number];

/** Incident severity (ehs.incident.severity). Mirrors the CHECK in migration 035. */
export const INCIDENT_SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITY)[number];

/**
 * Incident lifecycle (ehs.incident.status):
 *   REPORTED -> INVESTIGATING -> CLOSED
 * An incident is logged REPORTED; startInvestigation moves it to INVESTIGATING once
 * the root-cause review begins; close (the sign-off, EHS.APPROVE) retires it once a
 * corrective action is recorded — it stamps closed_at and emits 'ehs.incident.closed'.
 * CLOSED is terminal.
 */
export const INCIDENT_STATUS = ['REPORTED', 'INVESTIGATING', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  REPORTED: ['INVESTIGATING'],
  INVESTIGATING: ['CLOSED'],
  CLOSED: [], // terminal
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Document-numbering type registered in mdm.numbering_rule (prefix 'INC'). */
export const DOC_TYPE = 'INCIDENT';

/**
 * RBAC permission codes for this module (the 'EHS' domain is seeded in migration 035 —
 * it is NOT in the db/08 catalog). Anyone on the floor can REPORT an incident, so the
 * operational roles get view + create; QC owns the investigation + closure. Grants:
 *   PRODUCTION / STORES / INSTALL / SERVICE / PURCHASE / PLANNING / HR = VC  (report),
 *   QC    = VCEDA  (own investigation + closure: view/create/edit/delete/approve),
 *   ADMIN = VCEDAX (all six),
 *   CEO   = VAX    (view + approve/sign-off + export).
 * create (REPORTED) -> EHS.CREATE; update + startInvestigation -> EHS.EDIT;
 * close (the sign-off) -> EHS.APPROVE; reads -> EHS.VIEW; soft-delete -> EHS.DELETE;
 * CSV export -> EHS.EXPORT.
 */
export const EHS_PERMS = {
  VIEW: 'EHS.VIEW',
  CREATE: 'EHS.CREATE',
  EDIT: 'EHS.EDIT',
  DELETE: 'EHS.DELETE',
  APPROVE: 'EHS.APPROVE',
  EXPORT: 'EHS.EXPORT',
} as const;

/**
 * Domain event emitted when an incident is CLOSED (atomically with the status change
 * via the transactional outbox). Payload:
 *   { incidentNo, incidentType, severity }.
 * Downstream consumers (EHS dashboard / safety KPIs / regulatory reporting) react to
 * an incident being investigated and signed off.
 */
export const EHS_INCIDENT_CLOSED_EVENT = 'ehs.incident.closed';
