import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { TreasuryRepository } from './treasury.repository';
import { TreasuryService } from './treasury.service';
import { TreasuryController } from './treasury.controller';
import { TREASURY_PERMS } from './treasury.constants';
import { createForecastSchema, listQuerySchema, summaryQuerySchema } from './treasury.dto';

/**
 * Compose the Treasury / Cash-flow module (repository -> service -> controller) and
 * its routes. Append-only forecast: create + reads (list / summary / position) + CSV
 * export only — there is NO update and NO delete endpoint (a forecast entry is an
 * immutable snapshot; a correction is a new offsetting row).
 */
export function treasuryRouter(pool: Pool): Router {
  const controller = new TreasuryController(new TreasuryService(new TreasuryRepository(pool)));
  const r = Router();
  const P = TREASURY_PERMS;

  // Working-capital position snapshot over the live AR / AP ledgers + the forecast.
  r.get('/position',
    requirePermission(P.VIEW),
    asyncHandler(controller.position));

  // Forecast log: export + summary first, then the list / append on the bare path.
  // (The sub-paths are distinct, so match order is not load-bearing here.)
  r.get('/forecasts/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/forecasts/summary',
    requirePermission(P.VIEW),
    validate(summaryQuerySchema, 'query'),
    asyncHandler(controller.summary));

  r.get('/forecasts',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/forecasts',
    requirePermission(P.CREATE),
    validate(createForecastSchema),
    asyncHandler(controller.create));

  return r;
}
