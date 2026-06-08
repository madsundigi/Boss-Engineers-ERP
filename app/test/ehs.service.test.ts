import { EhsService } from '../src/modules/ehs/ehs.service';
import { EhsRepository } from '../src/modules/ehs/ehs.repository';
import { RequestContext } from '../src/common/request-context';
import { Incident } from '../src/modules/ehs/ehs.types';
import { IncidentStatus } from '../src/modules/ehs/ehs.constants';
import { OutboxEventInput } from '../src/outbox/outbox';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};
const incident = (o: Partial<Incident> = {}): Incident => ({
  incidentId: 5, companyId: 1, buId: 1, incidentNo: 'INC/MUM/2026/000001', incidentDate: '2026-06-08',
  incidentType: 'INJURY', severity: 'HIGH', location: 'Bay 3', projectId: 9, description: 'cut hand',
  correctiveAction: null, status: 'REPORTED', reportedBy: 1, closedAt: null,
  createdAt: '', createdBy: 1, updatedAt: '', rowVersion: 1, ...o,
});

function make(over: Partial<EhsRepository> = {}) {
  const repo = {
    create: jest.fn(async () => incident()),
    findById: jest.fn(async () => incident()),
    list: jest.fn(),
    update: jest.fn(async () => incident()),
    setStatus: jest.fn(async () => incident()),
    softDelete: jest.fn(async () => true),
    ...over,
  } as unknown as EhsRepository;
  return { svc: new EhsService(repo), repo };
}

describe('EhsService', () => {
  it('create delegates to the repository (branch present)', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { incidentType: 'INJURY', description: 'cut hand' });
    expect(repo.create).toHaveBeenCalled();
  });

  it('create requires a branch (x-bu-id) -> 400', async () => {
    const { svc } = make();
    const noBu = { ...ctx, buId: null };
    await expect(svc.create(noBu, { incidentType: 'INJURY', description: 'x' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('getById throws 404 when missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 5)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update is blocked on a CLOSED incident (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => incident({ status: 'CLOSED' })) });
    await expect(svc.update(ctx, 5, { description: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 5, { description: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('startInvestigation REPORTED->INVESTIGATING (no event)', async () => {
    const { svc, repo } = make();
    await svc.startInvestigation(ctx, 5, 1);
    expect(repo.setStatus).toHaveBeenCalledWith(ctx, 5, 1, 'INVESTIGATING');
  });

  it('startInvestigation from a terminal status is rejected (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => incident({ status: 'CLOSED' })) });
    await expect(svc.startInvestigation(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('close is blocked when not INVESTIGATING (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => incident({ status: 'REPORTED', correctiveAction: 'done' })) });
    await expect(svc.close(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('close requires a corrective action (400)', async () => {
    const { svc } = make({ findById: jest.fn(async () => incident({ status: 'INVESTIGATING', correctiveAction: null })) });
    await expect(svc.close(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('close emits ehs.incident.closed atomically (with corrective action)', async () => {
    let captured: OutboxEventInput | undefined;
    let closedFlag = false;
    const { svc } = make({
      findById: jest.fn(async () => incident({ status: 'INVESTIGATING', correctiveAction: 'guard fitted' })),
      setStatus: jest.fn(async (
        _c: RequestContext, _i: number, _v: number, _s: IncidentStatus,
        opts?: { setClosedAt?: boolean; event?: OutboxEventInput },
      ) => {
        captured = opts?.event; closedFlag = !!opts?.setClosedAt;
        return incident({ status: 'CLOSED', closedAt: '2026-06-08T00:00:00.000Z' });
      }) as unknown as EhsRepository['setStatus'],
    });
    await svc.close(ctx, 5, 1);
    expect(closedFlag).toBe(true);
    expect(captured?.eventType).toBe('ehs.incident.closed');
    expect(captured?.payload).toMatchObject({ incidentNo: 'INC/MUM/2026/000001', incidentType: 'INJURY', severity: 'HIGH' });
  });

  it('close returns 409 on a row-version mismatch', async () => {
    const { svc } = make({
      findById: jest.fn(async () => incident({ status: 'INVESTIGATING', correctiveAction: 'done' })),
      setStatus: jest.fn(async () => null),
    });
    await expect(svc.close(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete only allowed from REPORTED', async () => {
    const { svc } = make({ findById: jest.fn(async () => incident({ status: 'INVESTIGATING' })) });
    await expect(svc.delete(ctx, 5, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
