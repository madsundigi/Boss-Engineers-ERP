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

  // All /api routes are authenticated (gateway-injected identity + tenant).
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));

  app.use('/api/enquiries', enquiryRouter(pool));
  app.use('/api/quotations', quotationRouter(pool));
  app.use('/api/projects', projectRouter(pool));
  app.use('/api/inventory', inventoryRouter(pool));
  app.use('/api/workload', workloadRouter(pool));
  app.use('/api/fat', fatRouter(pool));

  // Transactional outbox relay: dispatches committed domain events (e.g. emails
  // the quotation PDF on 'quotation.sent'). Exposed for the server poller and tests.
  const email = new EmailService(deps.emailTransport ?? buildEmailTransport());
  // Placeholder ack for domain events whose consumers aren't built yet (so they
  // are PROCESSED, not dead-lettered). Replaced by real handlers in later waves
  // (e.g. quotation.won -> project, fat.passed -> dispatch clearance).
  const ack: OutboxHandler = async () => undefined;
  const handlers = new Map<string, OutboxHandler>([
    ['quotation.sent', quotationSentHandler(pool, new PdfService(), email)],
    ['project.created', ack],
    ['project.approved', ack],
    ['fat.passed', ack],
  ]);
  app.locals.outboxRelay = new OutboxRelay(pool, handlers);

  app.use(errorMiddleware);
  return app;
}
