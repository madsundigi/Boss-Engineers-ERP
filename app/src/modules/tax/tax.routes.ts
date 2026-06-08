import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { TaxRepository } from './tax.repository';
import { TaxService } from './tax.service';
import { TaxController } from './tax.controller';
import { TAX_PERMS } from './tax.constants';
import { getEInvoiceProvider } from '../../services/einvoice';
import {
  createTaxCodeSchema, setActiveSchema, taxCodeQuerySchema, generateEInvoiceSchema,
  generateEwayBillSchema, txnQuerySchema, summaryQuerySchema,
} from './tax.dto';

/**
 * Compose the GST / Tax module (repository -> service -> controller) and its
 * routes. Deny-by-default RBAC per route: every handler is guarded by exactly one
 * TAX.* permission. Literal paths are registered before the parameterised tax-code
 * routes so they are not captured as an :id.
 */
export function taxRouter(pool: Pool): Router {
  // Choose the e-invoice/e-way provider once at composition time (mock by
  // default; the live NIC IRP when EINVOICE_PROVIDER=nic and creds are present).
  const einvoice = getEInvoiceProvider(pool);
  const controller = new TaxController(new TaxService(new TaxRepository(pool), einvoice));
  const r = Router();
  const P = TAX_PERMS;

  // --- GST register reads / export (literal paths before '/codes/:id') ---
  r.get('/transactions',
    requirePermission(P.VIEW),
    validate(txnQuerySchema, 'query'),
    asyncHandler(controller.listTransactions));

  r.get('/summary',
    requirePermission(P.VIEW),
    validate(summaryQuerySchema, 'query'),
    asyncHandler(controller.summary));

  r.get('/export',
    requirePermission(P.EXPORT),
    validate(txnQuerySchema, 'query'),
    asyncHandler(controller.exportCsv));

  // --- E-invoice (IRN) + e-way bill generation (guarded by TAX.CREATE) ---
  r.post('/invoices/:invoiceId/einvoice',
    requirePermission(P.CREATE),
    validate(generateEInvoiceSchema),
    asyncHandler(controller.generateEInvoice));

  r.post('/invoices/:invoiceId/ewaybill',
    requirePermission(P.CREATE),
    validate(generateEwayBillSchema),
    asyncHandler(controller.generateEwayBill));

  // --- Tax-code master (GST rate catalog) ---
  r.get('/codes',
    requirePermission(P.VIEW),
    validate(taxCodeQuerySchema, 'query'),
    asyncHandler(controller.listTaxCodes));

  r.post('/codes',
    requirePermission(P.CREATE),
    validate(createTaxCodeSchema),
    asyncHandler(controller.createTaxCode));

  r.get('/codes/:id',
    requirePermission(P.VIEW),
    asyncHandler(controller.getTaxCode));

  r.patch('/codes/:id/active',
    requirePermission(P.EDIT),
    validate(setActiveSchema),
    asyncHandler(controller.setActive));

  return r;
}
