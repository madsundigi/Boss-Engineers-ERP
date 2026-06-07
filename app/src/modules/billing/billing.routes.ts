import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { INVOICE_PERMS } from './billing.constants';
import {
  createInvoiceSchema, updateInvoiceSchema, cancelSchema, versionSchema, listQuerySchema,
  createReceiptSchema, receiptQuerySchema, createAdvanceSchema, adjustAdvanceSchema, advanceQuerySchema,
  createRetentionSchema, releaseRetentionSchema, retentionQuerySchema, recognizeRevenueSchema,
} from './billing.dto';

/**
 * Compose the AR / Billing module (repository -> service -> controller) and routes.
 * Deny-by-default RBAC per route: create + receipts/advances/retention/revenue ->
 * INVOICE.CREATE; update/post/markSent/cancel/adjust/release -> INVOICE.EDIT; every
 * read -> INVOICE.VIEW; soft-delete -> INVOICE.DELETE; CSV export -> INVOICE.EXPORT.
 *
 * Route ordering: the static sub-resource prefixes (receipts / advances /
 * retentions / revenue / export) are declared BEFORE the '/:id' invoice routes so
 * Express does not capture e.g. 'receipts' as an invoice id.
 */
export function billingRouter(pool: Pool): Router {
  const controller = new BillingController(new BillingService(new BillingRepository(pool)));
  const r = Router();
  const P = INVOICE_PERMS;

  // ---- Receipts & allocation (static prefix; before '/:id') ----
  r.post('/receipts',
    requirePermission(P.CREATE),
    validate(createReceiptSchema),
    asyncHandler(controller.createReceipt));

  r.get('/receipts',
    requirePermission(P.VIEW),
    validate(receiptQuerySchema, 'query'),
    asyncHandler(controller.listReceipts));

  r.get('/receipts/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getReceipt));

  // ---- Advances (static prefix; before '/:id') ----
  r.post('/advances',
    requirePermission(P.CREATE),
    validate(createAdvanceSchema),
    asyncHandler(controller.createAdvance));

  r.get('/advances',
    requirePermission(P.VIEW),
    validate(advanceQuerySchema, 'query'),
    asyncHandler(controller.listAdvances));

  r.post('/advances/:id/adjust',
    requirePermission(P.EDIT),
    validate(adjustAdvanceSchema),
    asyncHandler(controller.adjustAdvance));

  // ---- Retention (static prefix; before '/:id') ----
  r.post('/retentions',
    requirePermission(P.CREATE),
    validate(createRetentionSchema),
    asyncHandler(controller.createRetention));

  r.get('/retentions',
    requirePermission(P.VIEW),
    validate(retentionQuerySchema, 'query'),
    asyncHandler(controller.listRetentions));

  r.post('/retentions/:id/release',
    requirePermission(P.EDIT),
    validate(releaseRetentionSchema),
    asyncHandler(controller.releaseRetention));

  // ---- Revenue recognition (static prefix; before '/:id') ----
  r.post('/revenue',
    requirePermission(P.CREATE),
    validate(recognizeRevenueSchema),
    asyncHandler(controller.recognizeRevenue));

  r.get('/revenue/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.listRevenue));

  // ---- Invoice export (before '/:id' so it is not captured as an id) ----
  r.get('/export',
    requirePermission(P.EXPORT),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  // ---- Invoices ----
  r.get('/',
    requirePermission(P.VIEW),
    validate(listQuerySchema, 'query'),
    asyncHandler(controller.list));

  r.post('/',
    requirePermission(P.CREATE),
    validate(createInvoiceSchema),
    asyncHandler(controller.create));

  r.get('/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getById));

  r.patch('/:id',
    requirePermission(P.EDIT),
    validate(updateInvoiceSchema),
    asyncHandler(controller.update));

  // Post the invoice (DRAFT -> POSTED; emits invoice.posted) — INVOICE.EDIT.
  r.post('/:id/post',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.post));

  r.post('/:id/send',
    requirePermission(P.EDIT),
    validate(versionSchema),
    asyncHandler(controller.markSent));

  r.post('/:id/cancel',
    requirePermission(P.EDIT),
    validate(cancelSchema),
    asyncHandler(controller.cancel));

  r.delete('/:id',
    requirePermission(P.DELETE),
    asyncHandler(controller.remove));

  return r;
}
