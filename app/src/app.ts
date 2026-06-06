import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from './common/auth';
import { errorMiddleware } from './common/error-middleware';
import { enquiryRouter } from './modules/enquiry/enquiry.routes';

/**
 * Application factory (composition root for HTTP). Pure: takes a pool, returns a
 * configured Express app without listening — so tests can mount it directly.
 */
export function createApp(pool: Pool): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // All /api routes are authenticated (gateway-injected identity + tenant).
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/enquiries', enquiryRouter(pool));

  app.use(errorMiddleware);
  return app;
}
