import { RiskService } from '../src/modules/risk/risk.service';
import { RiskRepository } from '../src/modules/risk/risk.repository';
import { RequestContext } from '../src/common/request-context';
import { Risk } from '../src/modules/risk/risk.types';
import { RiskStatus } from '../src/modules/risk/risk.constants';
import { OutboxEventInput } from '../src/outbox/outbox';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};
const risk = (o: Partial<Risk> = {}): Risk => ({
  riskId: 5, companyId: 1, buId: 1, projectId: 9, title: 't', description: null, category: 'COST',
  likelihood: 4, impact: 5, severity: 20, mitigation: null, ownerId: null, dueDate: null,
  status: 'OPEN', createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});

function make(over: Partial<RiskRepository> = {}) {
  const repo = {
    create: jest.fn(async () => risk()),
    findById: jest.fn(async () => risk()),
    list: jest.fn(),
    update: jest.fn(async () => risk()),
    setStatus: jest.fn(async () => risk()),
    softDelete: jest.fn(async () => true),
    heatmap: jest.fn(),
    ...over,
  } as unknown as RiskRepository;
  return { svc: new RiskService(repo), repo };
}

describe('RiskService', () => {
  it('create delegates to the repository', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { projectId: 9, title: 't', likelihood: 4, impact: 5 });
    expect(repo.create).toHaveBeenCalled();
  });

  it('getById throws 404 when missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update is blocked on a terminal risk (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => risk({ status: 'CLOSED' })) });
    await expect(svc.update(ctx, 5, { title: 'x', rowVersion: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 5, { title: 'x', rowVersion: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('startMitigation OPEN->MITIGATING (no event)', async () => {
    const { svc, repo } = make();
    await svc.startMitigation(ctx, 5, 1);
    expect(repo.setStatus).toHaveBeenCalledWith(ctx, 5, 1, 'MITIGATING', undefined);
  });

  it('startMitigation from a terminal status is rejected (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => risk({ status: 'CLOSED' })) });
    await expect(svc.startMitigation(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('close emits project_risk.closed atomically', async () => {
    let captured: OutboxEventInput | undefined;
    const { svc } = make({
      findById: jest.fn(async () => risk({ status: 'MITIGATING' })),
      setStatus: jest.fn(async (_c: RequestContext, _i: number, _v: number, _s: RiskStatus, e?: OutboxEventInput) => {
        captured = e; return risk({ status: 'CLOSED' });
      }) as unknown as RiskRepository['setStatus'],
    });
    await svc.close(ctx, 5, 1);
    expect(captured?.eventType).toBe('project_risk.closed');
    expect(captured?.payload).toMatchObject({ riskId: 5, projectId: 9, status: 'CLOSED' });
  });

  it('delete only allowed from OPEN', async () => {
    const { svc } = make({ findById: jest.fn(async () => risk({ status: 'MITIGATING' })) });
    await expect(svc.delete(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
