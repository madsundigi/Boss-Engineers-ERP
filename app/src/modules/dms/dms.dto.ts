import { z } from 'zod';
import { DOCUMENT_STATUS, DOCUMENT_CATEGORY } from './dms.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();

/**
 * POST /api/documents — register a document in DRAFT (current_version 0). The
 * category + the (entity_type, entity_id) module link are optional. Tenant / branch
 * / user come from request context; doc_no is allocated server-side.
 */
export const createDocumentSchema = z.object({
  title: t(200).min(1, 'A document title is required'),
  category: z.enum(DOCUMENT_CATEGORY).optional(),
  entityType: t(20).optional(),
  entityId: id.optional(),
  ownerId: id.optional(),
});
export type CreateDocumentDto = z.infer<typeof createDocumentSchema>;

/**
 * POST /api/documents/:id/versions — add a new version. The CLIENT has already
 * uploaded the file to EXTERNAL object storage (S3 / blob) and passes the resulting
 * storageKey; this endpoint records the pointer + metadata and bumps the document's
 * current_version. The version number is assigned server-side (current_version + 1).
 */
export const addVersionSchema = z.object({
  storageKey: t(400).min(1, 'A storageKey (object-store key/URL) is required'),
  fileName: t(200).optional(),
  mimeType: t(100).optional(),
  sizeBytes: z.coerce.number().int().min(0).optional(),
  notes: t(300).optional(),
});
export type AddVersionDto = z.infer<typeof addVersionSchema>;

/** PATCH /api/documents/:id — edit header metadata (title / category / entity link)
 *  on a DRAFT or ACTIVE document. All fields optional except the optimistic-
 *  concurrency rowVersion. */
export const updateDocumentSchema = z.object({
  title: t(200).min(1).optional(),
  category: z.enum(DOCUMENT_CATEGORY).optional(),
  entityType: t(20).optional(),
  entityId: id.optional(),
  ownerId: id.optional(),
  rowVersion: z.coerce.number().int().positive(), // optimistic concurrency
});
export type UpdateDocumentDto = z.infer<typeof updateDocumentSchema>;

/** Optimistic-concurrency-only body (activate, archive, markObsolete, delete). */
export const versionSchema = z.object({ rowVersion: z.coerce.number().int().positive() });
export type VersionDto = z.infer<typeof versionSchema>;

/** GET /api/documents — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  status: z.enum(DOCUMENT_STATUS).optional(),
  category: z.enum(DOCUMENT_CATEGORY).optional(),
  entityType: t(20).optional(),
  entityId: id.optional(),
  q: t(60).optional(), // free-text on title
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['doc_no', 'title', 'category', 'status', 'created_at']).default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
