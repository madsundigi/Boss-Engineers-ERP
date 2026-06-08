import { z } from 'zod';
import { INCIDENT_STATUS, INCIDENT_TYPE, INCIDENT_SEVERITY } from './ehs.constants';

const t = (n: number) => z.string().trim().max(n);
const dateStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.coerce.number().int().positive();

/**
 * POST /api/ehs — log an incident in REPORTED. incident_no, reported_by, status and
 * closed_at are NOT accepted on the wire: the number is DB-allocated, reported_by /
 * tenant / branch come from request context, and the lifecycle is server-driven.
 */
export const createIncidentSchema = z.object({
  incidentDate: dateStr.optional(),
  incidentType: z.enum(INCIDENT_TYPE),
  severity: z.enum(INCIDENT_SEVERITY).optional(),
  location: t(100).optional(),
  projectId: id.optional(),
  description: t(8000).min(1, 'A description is required'),
  correctiveAction: t(8000).optional(),
});
export type CreateIncidentDto = z.infer<typeof createIncidentSchema>;

/** PATCH /api/ehs/:id — edit an incident (not CLOSED). All fields optional except the
 *  optimistic-concurrency rowVersion. */
export const updateIncidentSchema = z.object({
  incidentDate: dateStr.optional(),
  incidentType: z.enum(INCIDENT_TYPE).optional(),
  severity: z.enum(INCIDENT_SEVERITY).optional(),
  location: t(100).optional(),
  projectId: id.optional(),
  description: t(8000).min(1).optional(),
  correctiveAction: t(8000).optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateIncidentDto = z.infer<typeof updateIncidentSchema>;

/** Optimistic-concurrency-only body (startInvestigation, close). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/ehs — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUS).optional(),
  type: z.enum(INCIDENT_TYPE).optional(),
  severity: z.enum(INCIDENT_SEVERITY).optional(),
  projectId: id.optional(),
  q: t(60).optional(), // free-text on incident_no / location
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['incident_date', 'severity', 'status', 'incident_no', 'created_at']).default('incident_date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
