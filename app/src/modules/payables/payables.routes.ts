import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { PayablesRepository } from './payables.repository';
import { PayablesService } from './payables.service';
import { PayablesController } from './payables.controller';
import { AP_PERMS } from './payables.constants';
import {
  createVendorInvoiceSchema, updateVendorInvoiceSchema, disputeSchema, versionSchema,
  listQuerySchema, createPaymentSchema, paymentListQuerySchema,
} from './payables.dto';

/**
 * Compose the Accounts Payable module (repository -> service -> controller) and
 * routes. Deny-by-default RBAC per route: create + record-payment require
 * AP_INVOICE.CREATE; match / update / dispute require AP_INVOICE.EDIT; approve
 * requires AP_INVOICE.APPROVE; every read requires AP_INVOICE.VIEW; soft-delete
 * requires AP_INVOICE.DELETE; the CSV exports require AP_INVOICE.EXPORT.
 */
export function payablesRouter(pool: Pool): Router {
  const controller = new PayablesController(new PayablesService(new PayablesRepository(pool)));
  const r = Router();
  const P = AP_PERMS;

  // ---- Vendor payments (static prefixes declared BEFORE '/:id' so they are not
  //      captured as an invoice id). ----
  r.post('/payments',
    requirePermission(P.CREATE),
    validate(createPaymentSchema),
    asyncHandler(controller.createPayment));

  r.get('/payments/export',
    requirePermission(P.EXPORT),
    validate(paymentListQuerySchema, 'query'),
    asyncHandler(controller.exportPaymentsCsv));

  r.get('/payments',
    requirePermission(P.VIEW),
    validate(paymentListQuerySchema, 'query'),
    asyncHandler(controller.listPayments));

  // ---- Vendor invoices ----
  // '/export' must precede '/:id' so it is not captured as an id.
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
    validate(createVendorInvoiceSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateVendorInvoiceSchema),
    asyncHandler(controller.update));

  // 3-way match (PENDING -> MATCHED) — AP_INVOICE.EDIT.
  r.post('/:id/match',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.match));

  // Approve for payment (MATCHED -> APPROVED) — AP_INVOICE.APPROVE (emits event).
  r.post('/:id/approve',
    requirePermission(P.APPROVE),
    validate(versionSchema),
    asyncHandler(controller.approve));

  // Dispute (any non-PAID -> DISPUTED) — AP_INVOICE.EDIT.
  r.post('/:id/dispute',
    requirePermission(P.EDIT),
    validate(disputeSchema),
    asyncHandler(controller.dispute));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
