import { NotificationService } from '../src/modules/notification/notification.service';
import {
  NotificationRepository, NotificationInput,
} from '../src/modules/notification/notification.repository';
import { Notification, NotificationListResult } from '../src/modules/notification/notification.types';
import { RequestContext } from '../src/common/request-context';
import { AppError } from '../src/common/http-error';

/**
 * Unit tests — the service's business rules in isolation, with a hand-rolled fake
 * repository (no database). Covers: raise defaults the recipient to the caller;
 * markRead 404s when the notification is not the caller's; listMine surfaces the
 * unread count; markAllRead returns how many were flipped.
 */

const ctx = (userId = 7): RequestContext => ({
  userId,
  username: 'tester',
  companyId: 1,
  buId: 1,
  clientIp: '127.0.0.1',
  sessionId: 's1',
  permissions: new Set<string>(),
});

function row(over: Partial<Notification> = {}): Notification {
  return {
    notificationId: 1,
    companyId: 1,
    userId: 7,
    category: 'INFO',
    title: 'Hi',
    body: null,
    link: null,
    isRead: false,
    readAt: null,
    createdAt: '2026-06-07T00:00:00.000Z',
    createdBy: 7,
    ...over,
  };
}

/** A fake repo capturing the inputs the service passes + scripting returns. */
class FakeRepo {
  insertArg?: NotificationInput;
  markReadResult: Notification | null = null;
  markAllReadResult = 0;
  listResult: NotificationListResult = {
    rows: [], total: 0, unreadCount: 0, page: 1, pageSize: 25,
  };
  insertForRoleResult = 0;

  async insert(_ctx: RequestContext, n: NotificationInput): Promise<Notification> {
    this.insertArg = n;
    return row({ userId: n.userId, category: n.category as Notification['category'], title: n.title });
  }
  async insertForRole(): Promise<number> {
    return this.insertForRoleResult;
  }
  async listMine(): Promise<NotificationListResult> {
    return this.listResult;
  }
  async markRead(): Promise<Notification | null> {
    return this.markReadResult;
  }
  async markAllRead(): Promise<number> {
    return this.markAllReadResult;
  }
}

function make(): { svc: NotificationService; repo: FakeRepo } {
  const repo = new FakeRepo();
  const svc = new NotificationService(repo as unknown as NotificationRepository);
  return { svc, repo };
}

describe('NotificationService (unit)', () => {
  it('raise defaults the recipient to ctx.userId when userId is omitted', async () => {
    const { svc, repo } = make();
    await svc.raise(ctx(7), { category: 'INFO', title: 'Self note' });
    expect(repo.insertArg?.userId).toBe(7);
  });

  it('raise targets the supplied recipient when userId is given', async () => {
    const { svc, repo } = make();
    await svc.raise(ctx(7), { userId: 99, category: 'WARNING', title: 'For you' });
    expect(repo.insertArg?.userId).toBe(99);
    expect(repo.insertArg?.category).toBe('WARNING');
  });

  it('markRead returns the row when it is the caller\'s', async () => {
    const { svc, repo } = make();
    repo.markReadResult = row({ isRead: true, readAt: '2026-06-07T01:00:00.000Z' });
    const res = await svc.markRead(ctx(7), 1);
    expect(res.isRead).toBe(true);
  });

  it('markRead 404s when the notification is not the caller\'s', async () => {
    const { svc, repo } = make();
    repo.markReadResult = null; // repo scopes WHERE user_id = ctx.userId -> no row
    await expect(svc.markRead(ctx(7), 123)).rejects.toMatchObject({ statusCode: 404 } as Partial<AppError>);
  });

  it('listMine surfaces the unread count', async () => {
    const { svc, repo } = make();
    repo.listResult = { rows: [row()], total: 1, unreadCount: 3, page: 1, pageSize: 25 };
    const res = await svc.listMine(ctx(7), { page: 1, pageSize: 25 });
    expect(res.total).toBe(1);
    expect(res.unreadCount).toBe(3);
  });

  it('markAllRead returns the count flipped', async () => {
    const { svc, repo } = make();
    repo.markAllReadResult = 5;
    const res = await svc.markAllRead(ctx(7));
    expect(res.updated).toBe(5);
  });

  it('broadcast returns how many rows were created', async () => {
    const { svc, repo } = make();
    repo.insertForRoleResult = 4;
    const res = await svc.broadcast(ctx(7), { roleCode: 'PLANNING', category: 'INFO', title: 'All hands' });
    expect(res.created).toBe(4);
  });
});
