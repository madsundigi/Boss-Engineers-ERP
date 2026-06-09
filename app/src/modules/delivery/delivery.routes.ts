import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { DeliveryRepository } from './delivery.repository';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { DELIVERY_PERMS } from './delivery.constants';
import { createForecastSchema, listQuerySchema, riskParamsSchema } from './delivery.dto';

/**
 * Compose the Delivery Prediction module (repository -> service -> controller)
 * and its routes. Append-only: create + reads + CSV export only — there is NO
 * update and NO delete endpoint (a forecast is an immutable snapshot).
 */
export function deliveryRouter(pool: Pool): Router {
  const controller = new DeliveryController(new DeliveryService(new DeliveryRepository(pool)));
  const r = Router();
  const P = DELIVERY_PERMS;

  // Export must precede the parameterised routes so it is not captured as a param.
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createForecastSchema),
    asyncHandler(controller.create));

  // Latest forecast snapshot for a project (404 if the project has none).
  r.get('/latest/:projectId',
    requirePermission(P.VIEW),
    asyncHandler(controller.getLatest));

  // AUTO delivery-risk: Green/Yellow/Red derived from live upstream delay signals
  // (overdue POs + delayed WOs + pending/failed FATs). Read-only; 404 if no such project.
  r.get('/risk/:projectId',
    requirePermission(P.VIEW),
    validate(riskParamsSchema, 'params'),
    asyncHandler(controller.getRisk));

  return r;
}
