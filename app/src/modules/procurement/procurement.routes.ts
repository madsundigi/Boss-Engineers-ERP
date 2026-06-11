import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { ProcurementRepository } from './procurement.repository';
import { ProcurementService } from './procurement.service';
import { ProcurementController } from './procurement.controller';
import { PR_PERMS, PO_PERMS, GRN_PERMS } from './procurement.constants';
import {
  createPrSchema, createPoSchema, receiveGrnSchema, receiveAllSchema, versionSchema,
  prListQuerySchema, poListQuerySchema, grnListQuerySchema,
} from './procurement.dto';

/** Compose the procurement module (repository -> service -> controller) and routes. */
export function procurementRouter(pool: Pool): Router {
  const c = new ProcurementController(new ProcurementService(new ProcurementRepository(pool)));
  const r = Router();

  // ---- Purchase Requisitions: create -> submit -> approve --------------
  r.get('/purchase-requisitions',
    requirePermission(PR_PERMS.VIEW), validate(prListQuerySchema, 'query'), asyncHandler(c.listPr));
  r.post('/purchase-requisitions',
    requirePermission(PR_PERMS.CREATE), validate(createPrSchema), asyncHandler(c.createPr));
  r.get('/purchase-requisitions/:id',
    requirePermission(PR_PERMS.VIEW), asyncHandler(c.getPr));
  r.post('/purchase-requisitions/:id/submit',
    requirePermission(PR_PERMS.EDIT), validate(versionSchema), asyncHandler(c.submitPr));
  r.post('/purchase-requisitions/:id/approve',
    requirePermission(PR_PERMS.APPROVE), validate(versionSchema), asyncHandler(c.approvePr));

  // ---- Purchase Orders: create -> approve (by value; emits po.approved) -
  r.get('/purchase-orders',
    requirePermission(PO_PERMS.VIEW), validate(poListQuerySchema, 'query'), asyncHandler(c.listPo));
  r.post('/purchase-orders',
    requirePermission(PO_PERMS.CREATE), validate(createPoSchema), asyncHandler(c.createPo));
  r.get('/purchase-orders/:id',
    requirePermission(PO_PERMS.VIEW), asyncHandler(c.getPo));
  r.post('/purchase-orders/:id/approve',
    requirePermission(PO_PERMS.APPROVE), validate(versionSchema), asyncHandler(c.approvePo));
  // One-click receive: GRN for ALL outstanding qty on the PO. Gated on GRN.CREATE
  // (it creates a goods receipt); optional { warehouseId } body.
  r.post('/purchase-orders/:poId/receive',
    requirePermission(GRN_PERMS.CREATE), validate(receiveAllSchema), asyncHandler(c.receiveAllFromPo));

  // ---- Goods Receipt Notes: receive against a PO ----------------------
  r.get('/grn',
    requirePermission(GRN_PERMS.VIEW), validate(grnListQuerySchema, 'query'), asyncHandler(c.listGrn));
  r.post('/grn',
    requirePermission(GRN_PERMS.CREATE), validate(receiveGrnSchema), asyncHandler(c.receiveGrn));
  r.get('/grn/:id',
    requirePermission(GRN_PERMS.VIEW), asyncHandler(c.getGrn));

  return r;
}
