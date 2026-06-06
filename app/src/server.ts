import { createApp } from './app';
import { createPool } from './db/pool';
import { env } from './config/env';

const pool = createPool();
const app = createApp(pool);

const server = app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Boss Engineers ERP API listening on :${env.port} (${env.nodeEnv})`);
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
