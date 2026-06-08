/** Domain constants for the Project Risk Register module (Tier-3 value-add).
 *
 * A project-level risk: a discrete threat to a project's SCHEDULE / COST / QUALITY
 * / SUPPLY / SAFETY / COMMERCIAL or TECHNICAL outcome, scored on a 5x5 likelihood x
 * impact matrix (severity = likelihood * impact, computed in the database as a STORED
 * generated column), with a mitigation plan, an accountable owner and a lifecycle.
 * There is NO base table for it — migration 031 CREATES proj.project_risk and seeds
 * the 'RISK' RBAC domain (absent from the db/08 catalog).
 */

/**
 * Risk lifecycle (proj.project_risk.status):
 *   OPEN -> MITIGATING -> CLOSED   (+ ACCEPTED, reachable from OPEN or MITIGATING)
 * A risk is raised OPEN; startMitigation moves it to MITIGATING once a mitigation is
 * being actively worked; close (the sign-off, RISK.APPROVE) retires a mitigated risk;
 * accept (also RISK.APPROVE) formally tolerates the risk without further action.
 * CLOSED and ACCEPTED are terminal and emit 'project_risk.closed' downstream.
 */
export const RISK_STATUS = ['OPEN', 'MITIGATING', 'CLOSED', 'ACCEPTED'] as const;
export type RiskStatus = (typeof RISK_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<RiskStatus, RiskStatus[]> = {
  OPEN: ['MITIGATING', 'CLOSED', 'ACCEPTED'],
  MITIGATING: ['CLOSED', 'ACCEPTED'],
  CLOSED: [], // terminal
  ACCEPTED: [], // terminal
};

export function canTransition(from: RiskStatus, to: RiskStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Risk categories (proj.project_risk.category) — the source of the threat. Mirrors
 * the CHECK constraint in migration 031.
 */
export const RISK_CATEGORY = [
  'SCHEDULE', 'COST', 'QUALITY', 'SUPPLY', 'SAFETY', 'COMMERCIAL', 'TECHNICAL',
] as const;
export type RiskCategory = (typeof RISK_CATEGORY)[number];

/**
 * Likelihood and impact are each scored on a 1..5 ordinal scale; severity is their
 * product (1..25), computed by the database as a STORED generated column. The labels
 * document the scale for callers / UI; the DB only enforces the 1..5 bounds.
 */
export const LIKELIHOOD_SCALE = [
  { value: 1, label: 'Rare' },
  { value: 2, label: 'Unlikely' },
  { value: 3, label: 'Possible' },
  { value: 4, label: 'Likely' },
  { value: 5, label: 'Almost Certain' },
] as const;

export const IMPACT_SCALE = [
  { value: 1, label: 'Negligible' },
  { value: 2, label: 'Minor' },
  { value: 3, label: 'Moderate' },
  { value: 4, label: 'Major' },
  { value: 5, label: 'Severe' },
] as const;

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

/**
 * Severity bands for the heatmap / summary read (groups the 1..25 product into a
 * traffic-light band). LOW 1..4, MEDIUM 5..9, HIGH 10..15, CRITICAL 16..25.
 */
export type SeverityBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export function severityBand(severity: number): SeverityBand {
  if (severity >= 16) return 'CRITICAL';
  if (severity >= 10) return 'HIGH';
  if (severity >= 5) return 'MEDIUM';
  return 'LOW';
}

/**
 * RBAC permission codes for this module (the 'RISK' domain is seeded in migration
 * 031 — it is NOT in the db/08 catalog). Grants:
 *   PLANNING   = VCEDA  (own the register: view/create/edit/delete + approve),
 *   CEO        = VAX    (view + approve/sign-off + export),
 *   ADMIN      = VCEDAX (all six),
 *   PRODUCTION = VCE    (view/create/edit),
 *   QC         = VC     (view/create),
 *   FINANCE    = V      (read only),
 *   SALES      = V      (read only).
 * create -> RISK.CREATE; update / transition (startMitigation) -> RISK.EDIT;
 * close / accept (the sign-off) -> RISK.APPROVE; reads -> RISK.VIEW;
 * soft-delete -> RISK.DELETE; CSV export -> RISK.EXPORT.
 */
export const RISK_PERMS = {
  VIEW: 'RISK.VIEW',
  CREATE: 'RISK.CREATE',
  EDIT: 'RISK.EDIT',
  DELETE: 'RISK.DELETE',
  APPROVE: 'RISK.APPROVE',
  EXPORT: 'RISK.EXPORT',
} as const;

/**
 * Domain event emitted when a risk is CLOSED or ACCEPTED (atomically with the status
 * change via the transactional outbox). Payload:
 *   { riskId, projectId, severity, status }.
 * Downstream consumers (project profitability / CEO dashboard) react to a project
 * risk being retired.
 */
export const RISK_CLOSED_EVENT = 'project_risk.closed';
