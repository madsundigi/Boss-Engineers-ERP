/** Domain constants for the CRM module (FRD §11 Tier-2: beyond enquiry).
 *
 * The Enquiry module captures raw leads; CRM takes the qualified ones forward as a
 * sales OPPORTUNITY through a pipeline, with ACTIVITIES (calls / meetings / emails /
 * tasks / notes) as the follow-up trail and a customer-360 read that aggregates the
 * customer's opportunities + open activities (+ enquiry / quotation counts). There
 * is NO base table for any of it — migration 039 CREATES a NEW `crm` schema with
 * crm.opportunity + crm.activity and seeds the 'CRM' RBAC domain (absent from db/08).
 */

/**
 * Opportunity pipeline (crm.opportunity.stage):
 *   NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION -> WON | LOST
 * An opportunity is raised NEW; it advances forward one (or several) stages as the
 * deal matures. WON (win) and LOST (lose, with a reason) are terminal. WON emits
 * 'opportunity.won' atomically via the transactional outbox so downstream consumers
 * (quotation / project / CEO dashboard) react to a deal being closed.
 */
export const OPPORTUNITY_STAGE = [
  'NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST',
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGE)[number];

/**
 * The ordered forward pipeline (WON / LOST are terminal and reached only via the
 * dedicated win / lose actions, not setStage). Used to validate that a stage move
 * only goes forward along NEW -> QUALIFIED -> PROPOSAL -> NEGOTIATION.
 */
export const PIPELINE_ORDER: OpportunityStage[] = [
  'NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION',
];

/** Terminal (closed) stages — an opportunity here can no longer be edited / moved. */
export const TERMINAL_STAGES: OpportunityStage[] = ['WON', 'LOST'];

/**
 * Can an opportunity move from `from` to `to` via setStage / advanceStage? Only
 * forward moves along the open pipeline are allowed (a no-op same-stage move and any
 * backward move are rejected); WON / LOST are NOT reachable here (use win / lose).
 */
export function canAdvance(from: OpportunityStage, to: OpportunityStage): boolean {
  const fi = PIPELINE_ORDER.indexOf(from);
  const ti = PIPELINE_ORDER.indexOf(to);
  return fi >= 0 && ti >= 0 && ti > fi;
}

/**
 * Activity types (crm.activity.activity_type) — the kind of follow-up interaction.
 * Mirrors the CHECK constraint in migration 039.
 */
export const ACTIVITY_TYPE = ['CALL', 'MEETING', 'EMAIL', 'TASK', 'NOTE'] as const;
export type ActivityType = (typeof ACTIVITY_TYPE)[number];

/**
 * Activity lifecycle (crm.activity.status):
 *   PENDING -> DONE (completeActivity) | CANCELLED
 * A PENDING activity that is past its due_date is "overdue" (a list filter, not a
 * stored status).
 */
export const ACTIVITY_STATUS = ['PENDING', 'DONE', 'CANCELLED'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUS)[number];

/**
 * RBAC permission codes for this module (the 'CRM' domain is seeded in migration
 * 039 — it is NOT in the db/08 catalog). Grants:
 *   SALES    = VCEDA  (own the pipeline: view/create/edit/delete + approve),
 *   ADMIN    = VCEDAX (all six),
 *   CEO      = VAX    (view + approve + export),
 *   PLANNING = V      (read only),
 *   FINANCE  = V      (read only).
 * opportunity / activity create -> CRM.CREATE; update / stage / complete -> CRM.EDIT;
 * close-won / lost -> CRM.EDIT (APPROVE is a superset SALES/ADMIN/CEO also hold);
 * reads -> CRM.VIEW; soft-delete -> CRM.DELETE; CSV export -> CRM.EXPORT.
 */
export const CRM_PERMS = {
  VIEW: 'CRM.VIEW',
  CREATE: 'CRM.CREATE',
  EDIT: 'CRM.EDIT',
  DELETE: 'CRM.DELETE',
  APPROVE: 'CRM.APPROVE',
  EXPORT: 'CRM.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'OPP'). */
export const DOC_TYPE = 'OPPORTUNITY';

/**
 * Domain event emitted when an opportunity is WON (atomically with the stage change
 * via the transactional outbox). Payload: { oppNo, customerId, estValue }. Downstream
 * consumers (quotation / project / CEO dashboard) react to a deal being closed-won.
 */
export const OPPORTUNITY_WON_EVENT = 'opportunity.won';
