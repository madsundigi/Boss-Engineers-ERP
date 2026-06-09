import { z } from 'zod';
import { TEST_TYPES } from './fatprotocol.constants';

const t = (n: number) => z.string().trim().max(n);
const id = z.coerce.number().int().positive();
/** A spec bound: numeric(20,6), any sign (a tolerance band may be negative). */
const spec = z.coerce.number();

/**
 * A single checklist parameter line on create / replace. seq orders the line and is
 * unique within a protocol; param_name is required. The spec band + uom are optional.
 */
export const paramSchema = z.object({
  seq: z.coerce.number().int().min(1, 'seq must be >= 1'),
  paramName: t(150).min(1, 'A parameter name is required'),
  specMin: spec.optional(),
  specMax: spec.optional(),
  uom: t(20).optional(),
});
export type ParamDto = z.infer<typeof paramSchema>;

/**
 * POST /api/fat-protocols — define a protocol. protocol_code is user-supplied and
 * UNIQUE table-wide (the DB enforces it; the service maps the 23505 to a 409).
 * `params` is the optional checklist; the header + its lines are written in one
 * transaction. Tenant / user come from request context — never the body.
 */
export const createProtocolSchema = z.object({
  protocolCode: t(30).min(1, 'A protocol code is required'),
  protocolName: t(150).min(1, 'A protocol name is required'),
  itemId: id.optional(),
  testType: z.enum(TEST_TYPES).optional(),
  isActive: z.coerce.boolean().optional(),
  params: z.array(paramSchema).optional(),
});
export type CreateProtocolDto = z.infer<typeof createProtocolSchema>;

/**
 * PATCH /api/fat-protocols/:id — edit a protocol. protocol_code is immutable (the
 * stable business key). All header fields optional. If `params` is supplied the
 * whole checklist is REPLACED (delete-then-insert) atomically; omit it to leave the
 * lines untouched. The table has no row_version, so there is no concurrency token.
 */
export const updateProtocolSchema = z
  .object({
    protocolName: t(150).min(1).optional(),
    itemId: id.optional(),
    testType: z.enum(TEST_TYPES).optional(),
    isActive: z.coerce.boolean().optional(),
    params: z.array(paramSchema).optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    'No fields supplied to update',
  );
export type UpdateProtocolDto = z.infer<typeof updateProtocolSchema>;

/** GET /api/fat-protocols — list filters + pagination (all from the query string). */
export const listQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  testType: z.enum(TEST_TYPES).optional(),
  q: t(60).optional(), // free-text on protocol_code + protocol_name
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['protocol_code', 'protocol_name']).default('protocol_code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQueryDto = z.infer<typeof listQuerySchema>;
