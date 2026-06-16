import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { EnquiryRepository } from './enquiry.repository';
import { EnquiryService } from './enquiry.service';
import { EnquiryController } from './enquiry.controller';
import { ENQUIRY_PERMS } from './enquiry.constants';
import {
  createEnquirySchema, updateEnquirySchema, changeStatusSchema, approveSchema, assignSchema, listQuerySchema,
} from './enquiry.dto';

/** Compose the enquiry module (repository -> service -> controller) and routes. */
export function enquiryRouter(pool: Pool): Router {
  const controller = new EnquiryController(new EnquiryService(new EnquiryRepository(pool)));
  const r = Router();

  // Export must precede '/:id' so it is not captured as an id.
  r.get('/export',
    requirePermission(ENQUIRY_PERMS.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  r.get('/',
    requirePermission(ENQUIRY_PERMS.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(ENQUIRY_PERMS.CREATE),
    validate(createEnquirySchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(ENQUIRY_PERMS.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(ENQUIRY_PERMS.EDIT),
    validate(updateEnquirySchema),
    asyncHandler(controller.update));

  r.post('/:id/status',
    requirePermission(ENQUIRY_PERMS.EDIT),
    validate(changeStatusSchema),
    asyncHandler(controller.changeStatus));

  r.post('/:id/approve',
    requirePermission(ENQUIRY_PERMS.APPROVE),
    validate(approveSchema),
    asyncHandler(controller.approve));

  r.post('/:id/assign',
    requirePermission(ENQUIRY_PERMS.EDIT),
    validate(assignSchema),
    asyncHandler(controller.assign));

  r.delete('/:id',
    requirePermission(ENQUIRY_PERMS.DELETE),
    asyncHandler(controller.remove));

  return r;
}
