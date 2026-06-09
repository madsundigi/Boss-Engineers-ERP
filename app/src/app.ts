import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from './common/auth';
import { securityMiddlewares } from './common/security';
import { httpLogger } from './common/logger';
import { errorMiddleware } from './common/error-middleware';
import { enquiryRouter } from './modules/enquiry/enquiry.routes';
import { quotationRouter } from './modules/quotation/quotation.routes';
import { quotationSentHandler } from './modules/quotation/quotation.handlers';
import { projectRouter } from './modules/project/project.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { workloadRouter } from './modules/workload/workload.routes';
import { fatRouter } from './modules/fat/fat.routes';
import { planningRouter } from './modules/planning/planning.routes';
import { procurementRouter } from './modules/procurement/procurement.routes';
import { productionRouter } from './modules/production/production.routes';
import { dispatchRouter } from './modules/dispatch/dispatch.routes';
import { serviceRouter } from './modules/service/service.routes';
import { installationRouter } from './modules/installation/installation.routes';
import { failureRouter } from './modules/failure/failure.routes';
import { deliveryRouter } from './modules/delivery/delivery.routes';
import { bomRouter } from './modules/bom/bom.routes';
import { glRouter } from './modules/gl/gl.routes';
import { billingRouter } from './modules/billing/billing.routes';
import { payablesRouter } from './modules/payables/payables.routes';
import { taxRouter } from './modules/tax/tax.routes';
import { profitabilityRouter } from './modules/profitability/profitability.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { authRouter } from './modules/auth/auth.routes';
import { mfaRouter } from './modules/auth/mfa.routes';
import { changeRouter } from './modules/change/change.routes';
import { qualityRouter } from './modules/quality/quality.routes';
import { hrRouter } from './modules/hr/hr.routes';
import { subcontractRouter } from './modules/subcontract/subcontract.routes';
import { contractRouter } from './modules/contract/contract.routes';
import { notificationRouter } from './modules/notification/notification.routes';
import { riskRouter } from './modules/risk/risk.routes';
import { sparesRouter } from './modules/spares/spares.routes';
import { maintenanceRouter } from './modules/maintenance/maintenance.routes';
import { treasuryRouter } from './modules/treasury/treasury.routes';
import { ehsRouter } from './modules/ehs/ehs.routes';
import { usersRouter, rolesRouter } from './modules/users/users.routes';
import { documentRouter } from './modules/dms/dms.routes';
import { crmRouter } from './modules/crm/crm.routes';
import { portalRouter } from './modules/portal/portal.routes';
import { searchRouter } from './modules/search/search.routes';
import { itemsRouter } from './modules/items/items.routes';
import { vendorsRouter } from './modules/vendors/vendors.routes';
import { warehousesRouter } from './modules/warehouses/warehouses.routes';
import { customersRouter } from './modules/customers/customers.routes';
import { workCentersRouter } from './modules/workcenters/workcenters.routes';
import { fatProtocolRouter } from './modules/fatprotocol/fatprotocol.routes';
import {
  invoicePostedGlHandler, paymentReceivedGlHandler, vendorInvoiceApprovedGlHandler,
} from './modules/gl/gl.handlers';
import { quotationWonHandler } from './modules/project/project.handlers';
import { fatPassedClearQualityHandler, dispatchReleasedNotifyCustomerHandler } from './modules/dispatch/dispatch.handlers';
import { dispatchReleasedWarrantyHandler } from './modules/service/service.handlers';
import { installationAcceptedBillingHandler } from './modules/billing/billing.handlers';
import { EmailService, EmailTransport, buildEmailTransport } from './services/email.service';
import { PdfService } from './services/pdf.service';
import { OutboxRelay } from './outbox/relay';
import { OutboxHandler } from './outbox/outbox';

export interface AppDeps {
  /** Inject an email transport (e.g. OutboxTransport in tests). Defaults to SMTP-or-outbox by env. */
  emailTransport?: EmailTransport;
}

/**
 * Application factory (composition root for HTTP). Pure: takes a pool, returns a
 * configured Express app without listening — so tests can mount it directly.
 */
export function createApp(pool: Pool, deps: AppDeps = {}): Express {
  const app = express();
  app.use(httpLogger);                 // structured request logging (silent in tests)
  app.use(...securityMiddlewares());   // helmet + CORS allowlist + rate limiting
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Public token issuance (no auth guard) — clients log in here to get a JWT.
  app.use('/auth', authRouter(pool));

  // All /api routes are authenticated (gateway-injected identity + tenant).
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));

  // Identity echo for the authenticated caller (drives the frontend session).
  app.get('/api/me', (req, res) => {
    const ctx = req.context!; // guaranteed by authenticate() above
    res.json({
      userId: ctx.userId, username: ctx.username, companyId: ctx.companyId,
      buId: ctx.buId, permissions: [...ctx.permissions],
    });
  });
  app.use('/api/auth', mfaRouter(pool)); // authenticated MFA enrollment

  app.use('/api/enquiries', enquiryRouter(pool));
  app.use('/api/quotations', quotationRouter(pool));
  app.use('/api/projects', projectRouter(pool));
  app.use('/api/inventory', inventoryRouter(pool));
  app.use('/api/workload', workloadRouter(pool));
  app.use('/api/fat', fatRouter(pool));
  app.use('/api/planning', planningRouter(pool));
  app.use('/api/procurement', procurementRouter(pool));
  app.use('/api/work-orders', productionRouter(pool));
  app.use('/api/dispatch', dispatchRouter(pool));
  app.use('/api/service-tickets', serviceRouter(pool));
  app.use('/api/installations', installationRouter(pool));
  app.use('/api/ncrs', failureRouter(pool));
  app.use('/api/delivery-forecasts', deliveryRouter(pool));
  app.use('/api/boms', bomRouter(pool));
  app.use('/api/gl', glRouter(pool));
  app.use('/api/invoices', billingRouter(pool));
  app.use('/api/ap-invoices', payablesRouter(pool));
  app.use('/api/tax', taxRouter(pool));
  app.use('/api/profitability', profitabilityRouter(pool));
  app.use('/api/dashboard', dashboardRouter(pool));
  app.use('/api/change-orders', changeRouter(pool));
  app.use('/api/inspections', qualityRouter(pool));
  app.use('/api/hr', hrRouter(pool));
  app.use('/api/subcontracts', subcontractRouter(pool));
  app.use('/api/contracts', contractRouter(pool));
  app.use('/api/notifications', notificationRouter(pool));
  app.use('/api/risks', riskRouter(pool));
  app.use('/api/spares', sparesRouter(pool));
  app.use('/api/maintenance', maintenanceRouter(pool));
  app.use('/api/treasury', treasuryRouter(pool));
  app.use('/api/ehs', ehsRouter(pool));
  app.use('/api/users', usersRouter(pool));   // user administration (USER_MGMT)
  app.use('/api/roles', rolesRouter(pool));   // read-only role catalog (ROLE_MGMT.VIEW)
  app.use('/api/documents', documentRouter(pool)); // DMS (versioned document repository)
  app.use('/api/crm', crmRouter(pool));            // CRM pipeline + activities
  app.use('/api/portal', portalRouter(pool));      // customer/vendor self-service portal
  app.use('/api/search', searchRouter(pool));      // central cross-entity search (lifecycle traceability)

  // Master data management (catalog the client maintains: items, suppliers, stores, etc.)
  app.use('/api/items', itemsRouter(pool));
  app.use('/api/vendors', vendorsRouter(pool));
  app.use('/api/warehouses', warehousesRouter(pool));
  app.use('/api/customers', customersRouter(pool));
  app.use('/api/work-centers', workCentersRouter(pool));
  app.use('/api/fat-protocols', fatProtocolRouter(pool));

  // Transactional outbox relay: dispatches committed domain events (e.g. emails
  // the quotation PDF on 'quotation.sent'). Exposed for the server poller and tests.
  const email = new EmailService(deps.emailTransport ?? buildEmailTransport());
  // Placeholder ack for domain events whose consumers aren't built yet (so they
  // are PROCESSED, not dead-lettered). Replaced by real handlers in later waves
  // (e.g. quotation.won -> project, fat.passed -> dispatch clearance).
  const ack: OutboxHandler = async () => undefined;
  // Run several handlers for one event, in order. Each handler is independently
  // idempotent, so a retry of the whole event safely re-runs all of them.
  const compose = (...hs: OutboxHandler[]): OutboxHandler => async (e) => {
    for (const h of hs) await h(e);
  };
  const handlers = new Map<string, OutboxHandler>([
    ['quotation.sent', quotationSentHandler(pool, new PdfService(), email)],
    // Winning a quotation auto-seeds a Project (idempotent on quotation_id).
    ['quotation.won', quotationWonHandler(pool)],
    ['project.created', ack],
    ['project.approved', ack],
    // FAT pass opens the linked dispatch's quality gate.
    ['fat.passed', fatPassedClearQualityHandler(pool)],
    ['planning.baseline.approved', ack],
    ['po.approved', ack],
    ['workorder.created', ack],
    ['workorder.released', ack],
    ['workorder.completed', ack],
    // Releasing a dispatch starts warranty for each shipped serial.
    // Releasing a dispatch starts warranty per shipped serial AND notifies the customer.
    ['dispatch.released', compose(
      dispatchReleasedWarrantyHandler(pool),
      dispatchReleasedNotifyCustomerHandler(pool),
    )],
    ['service_ticket.resolved', ack],
    ['warranty_claim.approved', ack],
    // Customer acceptance (CAC) notifies Finance to raise the final invoice.
    ['installation.accepted', installationAcceptedBillingHandler(pool)],
    ['ncr.closed', ack],
    ['delivery.at_risk', ack],
    ['bom.released', ack],
    ['gl.journal.posted', ack],
    // Finance subledgers auto-post a balanced journal to the GL (idempotent).
    ['invoice.posted', invoicePostedGlHandler(pool)],
    ['payment.received', paymentReceivedGlHandler(pool)],
    ['vendor_invoice.approved', vendorInvoiceApprovedGlHandler(pool)],
    ['einvoice.generated', ack],
    ['eway_bill.generated', ack],
    ['margin.snapshot.created', ack],
    ['change_order.approved', ack],
    ['inspection.failed', ack],
    ['leave.approved', ack],
    ['subcontract.received', ack],
    ['contract.activated', ack],
    ['project_risk.closed', ack],
    ['maintenance.completed', ack],
    ['ehs.incident.closed', ack],
    ['opportunity.won', ack],
  ]);
  app.locals.outboxRelay = new OutboxRelay(pool, handlers);

  app.use(errorMiddleware);
  return app;
}
