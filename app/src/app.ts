import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from './common/auth';
import { securityMiddlewares } from './common/security';
import { httpLogger } from './common/logger';
import { errorMiddleware } from './common/error-middleware';
import { enquiryRouter } from './modules/enquiry/enquiry.routes';
import { quotationRouter } from './modules/quotation/quotation.routes';
import { EmailService, EmailTransport, buildEmailTransport } from './services/email.service';

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

  const email = new EmailService(deps.emailTransport ?? buildEmailTransport());
  app.use('/api/enquiries', enquiryRouter(pool));
  app.use('/api/quotations', quotationRouter(pool, email));

  app.use(errorMiddleware);
  return app;
}
