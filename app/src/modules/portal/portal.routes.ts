import { Router } from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../common/async-handler';
import { validate } from '../../common/validate';
import { requirePermission } from '../../common/rbac';
import { PortalRepository } from './portal.repository';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';
import { PORTAL_PERMS } from './portal.constants';
import { raiseTicketSchema } from './portal.dto';

/**
 * Compose the Customer / Vendor Portal module (repository -> service -> controller)
 * and its routes; mounted at /api/portal. READ-MOSTLY self-service: every endpoint
 * AUTO-SCOPES to the caller's linked customer / vendor (sec.app_user.customer_id /
 * vendor_id) so a portal user only sees their own data. Deny-by-default RBAC: reads
 * require PORTAL.VIEW; the two writes (raise-ticket, acknowledge-PO) PORTAL.CREATE.
 * The customer-vs-vendor 403 split is enforced in the service from the linkage.
 */
export function portalRouter(pool: Pool): Router {
  const controller = new PortalController(new PortalService(new PortalRepository(pool)));
  const r = Router();
  const P = PORTAL_PERMS;

  // Who am I? (linkage) — answers for everyone with PORTAL.VIEW, even kind 'none'.
  r.get('/me', requirePermission(P.VIEW), asyncHandler(controller.me));

  // --- Customer self-service (service 403s a non-customer caller) ---
  r.get('/projects', requirePermission(P.VIEW), asyncHandler(controller.projects));
  r.get('/dispatches', requirePermission(P.VIEW), asyncHandler(controller.dispatches));
  r.get('/invoices', requirePermission(P.VIEW), asyncHandler(controller.invoices));
  r.get('/tickets', requirePermission(P.VIEW), asyncHandler(controller.tickets));
  r.post('/tickets',
    requirePermission(P.CREATE),
    validate(raiseTicketSchema),
    asyncHandler(controller.raiseTicket));

  // --- Vendor self-service (service 403s a non-vendor caller) ---
  r.get('/purchase-orders', requirePermission(P.VIEW), asyncHandler(controller.purchaseOrders));
  r.get('/grns', requirePermission(P.VIEW), asyncHandler(controller.grns));
  r.get('/payments', requirePermission(P.VIEW), asyncHandler(controller.payments));
  r.post('/purchase-orders/:id/acknowledge',
    requirePermission(P.CREATE),
    asyncHandler(controller.acknowledgePurchaseOrder));

  return r;
}
