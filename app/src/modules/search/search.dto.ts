import { z } from 'zod';
import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from './search.constants';

/**
 * Query params for GET /api/search. `q` is the (trimmed, bounded) search term and
 * `limit` is the per-group hit cap (coerced from the query string, defaulted, and
 * clamped to [1, SEARCH_MAX_LIMIT]). Mirrors the validate(...,'query') pattern used
 * across the read modules.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(160),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
});
export type SearchQueryDto = z.infer<typeof searchQuerySchema>;
