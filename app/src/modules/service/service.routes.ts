import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ServiceRepository } from './service.repository';
import { ServiceService } from './service.service';
import { ServiceController } from './service.controller';
import { SERVICE_PERMS } from './service.constants';
import {
  createTicketSchema, updateTicketSchema, assignSchema, resolveSchema, cancelSchema,
  warrantyClaimSchema, versionSchema, listQuerySchema,
} from './service.dto';

/** Compose the Warranty & Service module (repository -> service -> controller) and routes. */
export function serviceRouter(pool: Pool): Router {
  const controller = new ServiceController(new ServiceService(new ServiceRepository(pool)));
  const r = Router();
  const P = SERVICE_PERMS;

  // Export must precede '/:id' so it is not captured as an id.
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
    validate(createTicketSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateTicketSchema),
    asyncHandler(controller.update));

  // Assign a field engineer.
  r.post('/:id/assign',
    requirePermission(P.EDIT),
    validate(assignSchema),
    asyncHandler(controller.assign));

  // Begin work on site.
  r.post('/:id/start',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.start));

  // Record the resolution (emits service_ticket.resolved).
  r.post('/:id/resolve',
    requirePermission(P.EDIT),
    validate(resolveSchema),
    asyncHandler(controller.resolve));

  // Customer-confirmed closure.
  r.post('/:id/close',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.close));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(cancelSchema),
    asyncHandler(controller.cancel));

  // Warranty-claim validity / goodwill (concession) approval — SERVICE_TICKET.APPROVE.
  r.post('/:id/warranty-claim',
    requirePermission(P.APPROVE),
    validate(warrantyClaimSchema),
    asyncHandler(controller.warrantyClaim));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
