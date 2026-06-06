import { createApp } from './app';
import { createPool } from './db/pool';
import { env } from './config/env';
import { OutboxRelay } from './outbox/relay';

const pool = createPool();
const app = createApp(pool);

// Start the transactional-outbox relay (background dispatch of domain events).
const relay = app.locals.outboxRelay as OutboxRelay;
relay.start();

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Boss Engineers ERP API listening on :${env.port} (${env.nodeEnv})`);
});

async function shutdown() {
  relay.stop();
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
