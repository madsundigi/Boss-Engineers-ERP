import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { searchQuerySchema } from './search.dto';

/**
 * Compose the Central Search module (repository -> service -> controller) and its
 * route. READ-ONLY: a single GET endpoint, no create/update/delete, no outbox events.
 * Deny-by-default RBAC: the route requires the baseline DASHBOARD.VIEW (held by every
 * operational role); each entity group is then ADDITIONALLY gated in the service on
 * the caller's per-module VIEW permission.
 */
export function searchRouter(pool: Pool): Router {
  const controller = new SearchController(new SearchService(new SearchRepository(pool)));
  const r = Router();

  r.get('/',
    requirePermission('DASHBOARD.VIEW'),
    validate(searchQuerySchema, 'query'),
    asyncHandler(controller.search));

  return r;
}
