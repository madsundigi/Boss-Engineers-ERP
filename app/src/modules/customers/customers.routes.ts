import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CUSTOMER_PERMS } from './customers.constants';
import {
  createCustomerSchema, updateCustomerSchema, versionSchema, listQuerySchema,
} from './customers.dto';

/** Compose the Customer master module (repository -> service -> controller). */
export function customersRouter(pool: Pool): Router {
  const controller = new CustomersController(new CustomersService(new CustomersRepository(pool)));
  const r = Router();

  r.get('/', requirePermission(CUSTOMER_PERMS.VIEW), validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));
  r.post('/', requirePermission(CUSTOMER_PERMS.CREATE), validate(createCustomerSchema),
    asyncHandler(controller.create));

  r.get('/:id', requirePermission(CUSTOMER_PERMS.VIEW), asyncHandler(controller.getById));
  r.patch('/:id', requirePermission(CUSTOMER_PERMS.EDIT), validate(updateCustomerSchema),
    asyncHandler(controller.update));
  r.delete('/:id', requirePermission(CUSTOMER_PERMS.DELETE), validate(versionSchema, 'query'),
    asyncHandler(controller.remove));

  return r;
}
