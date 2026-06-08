import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { AuthService, authenticate } from '../src/common/auth';
import { errorMiddleware } from '../src/common/error-middleware';
import { notificationRouter } from '../src/modules/notification/notification.routes';

/**
 * Integration tests — exercise the full HTTP stack (auth -> RBAC guard ->
 * validation -> service -> repository -> PostgreSQL) against a real database.
 * Runs only when DATABASE_URL is set (provisioned by the test harness) so the
 * suite is a no-op in environments without a database.
 *
 * The app mounts notificationRouter at /api/notifications exactly as the
 * composition root does; here we mount a minimal equivalent so the module is
 * testable independently of app.ts.
 *
 * A per-user store: any user raises a notification for a recipient (default =
 * self) and every user lists + mark-reads their OWN. A user may only mark THEIR
 * OWN read — marking someone else's (or a non-existent) -> 404.
 */
const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

function buildApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());
  const auth = new AuthService(pool);
  app.use('/api', authenticate(auth));
  app.use('/api/notifications', notificationRouter(pool));
  app.use(errorMiddleware);
  return app;
}

d('Notification API (integration) — raise, list-mine, mark-read, RBAC', () => {
  let pool: Pool;
  let app: Express;
  let companyId: number;
  let buId: number;
  let adminUser: number;
  let salesUser: number;

  const hdr = (userId: number) => ({
    'x-user-id': String(userId),
    'x-company-id': String(companyId),
    'x-bu-id': String(buId),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    app = buildApp(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

    companyId = Number((await one(`SELECT company_id FROM mdm.company WHERE company_code='BE'`)).company_id);
    buId = Number((await one(`SELECT bu_id FROM mdm.business_unit WHERE bu_code='MUM' AND company_id=$1`, [companyId])).bu_id);
    adminUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='admin_user'`)).user_id);
    salesUser = Number((await one(`SELECT user_id FROM sec.app_user WHERE username='sales_user'`)).user_id);
  });

  afterAll(async () => { await pool.end(); });

  let createdId: number;

  it('requires authentication (401) without identity headers', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('raises a notification to oneself (201), recipient defaults to the caller', async () => {
    const res = await request(app).post('/api/notifications').set(hdr(adminUser)).send({
      category: 'INFO', title: 'Build finished', body: 'Wave 5b complete', link: '/builds/5b',
    });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(adminUser);
    expect(res.body.category).toBe('INFO');
    expect(res.body.isRead).toBe(false);
    createdId = res.body.notificationId;
  });

  it('rejects an invalid body (400): missing required title', async () => {
    const res = await request(app).post('/api/notifications').set(hdr(adminUser)).send({ category: 'INFO' });
    expect(res.status).toBe(400);
  });

  it('lists the caller\'s own notifications (200) with an unread count', async () => {
    const res = await request(app).get('/api/notifications').set(hdr(adminUser));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.unreadCount).toBeGreaterThanOrEqual(1);
    // the just-raised row is present and belongs to the caller
    expect(res.body.rows.every((n: { userId: number }) => n.userId === adminUser)).toBe(true);
  });

  it('marks one own notification read (200), then the unread count drops', async () => {
    const before = await request(app).get('/api/notifications').set(hdr(adminUser));
    const beforeUnread = before.body.unreadCount;

    const read = await request(app).post(`/api/notifications/${createdId}/read`).set(hdr(adminUser)).send({});
    expect(read.status).toBe(200);
    expect(read.body.isRead).toBe(true);
    expect(read.body.readAt).not.toBeNull();

    const after = await request(app).get('/api/notifications').set(hdr(adminUser));
    expect(after.body.unreadCount).toBe(beforeUnread - 1);
  });

  it('404s when marking a notification that is not the caller\'s', async () => {
    // sales raises one for THEMSELVES, then admin tries to mark it read -> not admin's row.
    const mine = await request(app).post('/api/notifications').set(hdr(salesUser))
      .send({ category: 'WARNING', title: 'Sales-only alert' });
    expect(mine.status).toBe(201);
    const notMine = await request(app).post(`/api/notifications/${mine.body.notificationId}/read`)
      .set(hdr(adminUser)).send({});
    expect(notMine.status).toBe(404);
    // a clearly non-existent id also 404s
    const ghost = await request(app).post('/api/notifications/99999999/read').set(hdr(adminUser)).send({});
    expect(ghost.status).toBe(404);
  });

  it('marks all the caller\'s unread read (200), then the unread count is 0', async () => {
    // raise a couple more so there is something to clear
    await request(app).post('/api/notifications').set(hdr(adminUser)).send({ category: 'INFO', title: 'A' });
    await request(app).post('/api/notifications').set(hdr(adminUser)).send({ category: 'ERROR', title: 'B' });

    const res = await request(app).post('/api/notifications/read-all').set(hdr(adminUser)).send({});
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);

    const after = await request(app).get('/api/notifications').set(hdr(adminUser));
    expect(after.body.unreadCount).toBe(0);
  });
});
