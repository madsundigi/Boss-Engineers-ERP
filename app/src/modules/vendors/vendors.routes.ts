import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { VendorsRepository } from './vendors.repository';
import { VendorsService } from './vendors.service';
import { VendorsController } from './vendors.controller';
import { VENDOR_PERMS } from './vendors.constants';
import { createVendorSchema, updateVendorSchema, versionSchema, listQuerySchema } from './vendors.dto';

/** Compose the Vendor master module (repository -> service -> controller). */
export function vendorsRouter(pool: Pool): Router {
  const controller = new VendorsController(new VendorsService(new VendorsRepository(pool)));
  const r = Router();

  r.get('/', requirePermission(VENDOR_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(VENDOR_PERMS.CREATE), validate(createVendorSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(VENDOR_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(VENDOR_PERMS.EDIT), validate(updateVendorSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(VENDOR_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  return r;
}
