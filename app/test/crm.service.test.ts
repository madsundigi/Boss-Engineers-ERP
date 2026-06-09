import { CrmService } from '../src/modules/crm/crm.service';
import { CrmRepository } from '../src/modules/crm/crm.repository';
import { RequestContext } from '../src/common/request-context';
import { Opportunity, Activity, PipelineStageSummary } from '../src/modules/crm/crm.types';
import { AppError } from '../src/common/http-error';
import { OPPORTUNITY_WON_EVENT } from '../src/modules/crm/crm.constants';

const ctx: RequestContext = {
  userId: 5, username: 'sales', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    oppId: 40, oppNo: 'OPP/MUM/2026-27/000040', companyId: 1, buId: 1,
    customerId: 50, enquiryId: null, title: 'Pumping skid for Plant 2',
    stage: 'NEW', estValue: 250000, probabilityPct: 20, expectedCloseDate: '2026-09-30',
    ownerId: 5, lostReason: null,
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1, ...over,
  };
}

function activity(over: Partial<Activity> = {}): Activity {
  return {
    activityId: 70, companyId: 1, oppId: 40, customerId: 50,
    activityType: 'CALL', subject: 'Intro call', dueDate: '2026-07-01',
    completedAt: null, status: 'PENDING', ownerId: 5, notes: null,
    createdAt: 't', createdBy: 5, updatedAt: 't', rowVersion: 1, ...over,
  };
}

function makeRepo() {
  return {
    createOpportunity: jest.fn(),
    findOpportunity: jest.fn(),
    listOpportunities: jest.fn(),
    updateOpportunity: jest.fn(),
    setStage: jest.fn(),
    softDeleteOpportunity: jest.fn(),
    pipelineSummary: jest.fn(),
    revenueForecast: jest.fn(),
    createActivity: jest.fn(),
    findActivity: jest.fn(),
    listActivities: jest.fn(),
    completeActivity: jest.fn(),
    customer360: jest.fn(),
  } as unknown as jest.Mocked<CrmRepository>;
}

/** Resolve a promise to 0 on success, else to the AppError statusCode. */
const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('CrmService', () => {
  let repo: jest.Mocked<CrmRepository>;
  let service: CrmService;
  beforeEach(() => { repo = makeRepo(); service = new CrmService(repo); });

  describe('createOpportunity', () => {
    it('creates in NEW, rounding est_value and defaulting probability', async () => {
      const created = opp();
      repo.createOpportunity.mockResolvedValue(created);
      const out = await service.createOpportunity(ctx, { customerId: 50, title: 'X', estValue: 250000 });
      expect(out).toBe(created);
      const [, header] = repo.createOpportunity.mock.calls[0];
      expect(header).toMatchObject({ customerId: 50, title: 'X', estValue: 250000, probabilityPct: 0 });
    });

    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.createOpportunity({ ...ctx, buId: null }, { customerId: 50, title: 'X' })))
        .resolves.toBe(400);
      expect(repo.createOpportunity).not.toHaveBeenCalled();
    });
  });

  describe('getOpportunity', () => {
    it('404 when not found', async () => {
      repo.findOpportunity.mockResolvedValue(null);
      await expect(code(service.getOpportunity(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('advanceStage (forward transitions)', () => {
    it('advances NEW -> QUALIFIED', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'NEW' }));
      repo.setStage.mockResolvedValue(opp({ stage: 'QUALIFIED', rowVersion: 2 }));
      const out = await service.advanceStage(ctx, 40, { stage: 'QUALIFIED', rowVersion: 1 });
      expect(out.stage).toBe('QUALIFIED');
      const [, , , stage] = repo.setStage.mock.calls[0];
      expect(stage).toBe('QUALIFIED');
    });

    it('409 on a backward / same-stage move (PROPOSAL -> QUALIFIED)', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'PROPOSAL' }));
      await expect(code(service.advanceStage(ctx, 40, { stage: 'QUALIFIED', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.setStage).not.toHaveBeenCalled();
    });

    it('409 when advancing a terminal (WON) opportunity', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'WON' }));
      await expect(code(service.advanceStage(ctx, 40, { stage: 'NEGOTIATION', rowVersion: 1 }))).resolves.toBe(409);
    });

    it('409 on a stale row version', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'NEW' }));
      repo.setStage.mockResolvedValue(null);
      await expect(code(service.advanceStage(ctx, 40, { stage: 'QUALIFIED', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('win (emits opportunity.won)', () => {
    it('moves to WON and emits opportunity.won with the expected payload', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'NEGOTIATION', estValue: 250000 }));
      repo.setStage.mockResolvedValue(opp({ stage: 'WON', rowVersion: 2 }));
      const out = await service.win(ctx, 40, 1);
      expect(out.stage).toBe('WON');
      const [, , , stage, opts] = repo.setStage.mock.calls[0];
      expect(stage).toBe('WON');
      expect(opts!.event).toMatchObject({
        eventType: OPPORTUNITY_WON_EVENT,
        aggregateType: 'OPPORTUNITY',
        payload: { oppNo: 'OPP/MUM/2026-27/000040', customerId: 50, estValue: 250000 },
      });
    });

    it('409 when winning an already-terminal opportunity', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'LOST' }));
      await expect(code(service.win(ctx, 40, 1))).resolves.toBe(409);
      expect(repo.setStage).not.toHaveBeenCalled();
    });
  });

  describe('lose (requires a reason)', () => {
    it('moves to LOST carrying the reason', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'PROPOSAL' }));
      repo.setStage.mockResolvedValue(opp({ stage: 'LOST', lostReason: 'price', rowVersion: 2 }));
      const out = await service.lose(ctx, 40, { lostReason: 'price', rowVersion: 1 });
      expect(out.stage).toBe('LOST');
      const [, , , stage, opts] = repo.setStage.mock.calls[0];
      expect(stage).toBe('LOST');
      expect(opts!.lostReason).toBe('price');
      expect(opts!.event).toBeUndefined();
    });

    it('409 when losing an already-terminal opportunity', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'WON' }));
      await expect(code(service.lose(ctx, 40, { lostReason: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('updateOpportunity', () => {
    it('409 when editing a terminal opportunity', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'WON' }));
      await expect(code(service.updateOpportunity(ctx, 40, { title: 'x', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateOpportunity).not.toHaveBeenCalled();
    });

    it('409 on a stale row version', async () => {
      repo.findOpportunity.mockResolvedValue(opp({ stage: 'NEW' }));
      repo.updateOpportunity.mockResolvedValue(null);
      await expect(code(service.updateOpportunity(ctx, 40, { title: 'x', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('pipelineSummary (mapping)', () => {
    it('passes through the repository stage summary', async () => {
      const summary: PipelineStageSummary[] = [
        { stage: 'NEW', count: 3, totalEstValue: 300000 },
        { stage: 'WON', count: 1, totalEstValue: 250000 },
      ];
      repo.pipelineSummary.mockResolvedValue(summary);
      const out = await service.pipelineSummary(ctx, 50);
      expect(out).toEqual(summary);
      expect(repo.pipelineSummary).toHaveBeenCalledWith(ctx, 50);
    });
  });

  describe('revenueForecast (assembles the weighted pipeline)', () => {
    it('folds per-stage parts into weightedTotal / grossOpenTotal and passes wonTotal through', async () => {
      repo.revenueForecast.mockResolvedValue({
        byStage: [
          { stage: 'NEW', count: 2, gross: 100000, weighted: 20000 },        // 20% of 100k
          { stage: 'PROPOSAL', count: 1, gross: 200000, weighted: 100000 },   // 50% of 200k
          { stage: 'NEGOTIATION', count: 1, gross: 400000, weighted: 320000 }, // 80% of 400k
        ],
        byMonth: [
          { month: '2026-09', count: 3, gross: 300000, weighted: 120000 },
          { month: 'unscheduled', count: 1, gross: 400000, weighted: 320000 },
        ],
        wonTotal: 250000,
      });

      const out = await service.revenueForecast(ctx, {});

      // grossOpenTotal = Σ gross; weightedTotal = Σ weighted (over open stages only).
      expect(out.grossOpenTotal).toBe(700000);
      expect(out.weightedTotal).toBe(440000);
      expect(out.wonTotal).toBe(250000);
      // breakdowns pass through unchanged.
      expect(out.byStage).toHaveLength(3);
      expect(out.byMonth).toEqual([
        { month: '2026-09', count: 3, gross: 300000, weighted: 120000 },
        { month: 'unscheduled', count: 1, gross: 400000, weighted: 320000 },
      ]);
      // no WON / LOST stage leaks into the open breakdown.
      expect(out.byStage.some((s) => s.stage === 'WON' || s.stage === 'LOST')).toBe(false);
      // the optional date window is threaded straight to the repository.
      expect(repo.revenueForecast).toHaveBeenCalledWith(ctx, {});
    });

    it('returns zeros / empty arrays for a company with no opportunities', async () => {
      repo.revenueForecast.mockResolvedValue({ byStage: [], byMonth: [], wonTotal: 0 });
      const out = await service.revenueForecast(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
      expect(out).toEqual({
        weightedTotal: 0, grossOpenTotal: 0, wonTotal: 0, byStage: [], byMonth: [],
      });
      expect(repo.revenueForecast).toHaveBeenCalledWith(ctx, { fromDate: '2026-01-01', toDate: '2026-12-31' });
    });

    it('rounds weighted sums to 4 dp (no float drift from probability weighting)', async () => {
      repo.revenueForecast.mockResolvedValue({
        byStage: [{ stage: 'NEW', count: 1, gross: 100, weighted: 33.3333333333 }],
        byMonth: [],
        wonTotal: 0,
      });
      const out = await service.revenueForecast(ctx, {});
      expect(out.weightedTotal).toBe(33.3333);
    });
  });

  describe('activities', () => {
    it('400 when an activity links to neither an opp nor a customer', async () => {
      await expect(code(service.createActivity(ctx, { activityType: 'CALL', subject: 'x' }))).resolves.toBe(400);
      expect(repo.createActivity).not.toHaveBeenCalled();
    });

    it('creates an activity linked to a customer', async () => {
      const created = activity({ oppId: null });
      repo.createActivity.mockResolvedValue(created);
      const out = await service.createActivity(ctx, { customerId: 50, activityType: 'CALL', subject: 'Intro call' });
      expect(out).toBe(created);
    });

    it('completes a PENDING activity (-> DONE)', async () => {
      repo.findActivity.mockResolvedValue(activity({ status: 'PENDING' }));
      repo.completeActivity.mockResolvedValue(activity({ status: 'DONE', completedAt: 't', rowVersion: 2 }));
      const out = await service.completeActivity(ctx, 70, 1);
      expect(out.status).toBe('DONE');
    });

    it('409 when completing a non-PENDING activity', async () => {
      repo.findActivity.mockResolvedValue(activity({ status: 'DONE' }));
      await expect(code(service.completeActivity(ctx, 70, 1))).resolves.toBe(409);
      expect(repo.completeActivity).not.toHaveBeenCalled();
    });

    it('404 when the activity is missing', async () => {
      repo.findActivity.mockResolvedValue(null);
      await expect(code(service.getActivity(ctx, 99))).resolves.toBe(404);
    });

    it('409 on a stale activity row version', async () => {
      repo.findActivity.mockResolvedValue(activity({ status: 'PENDING' }));
      repo.completeActivity.mockResolvedValue(null);
      await expect(code(service.completeActivity(ctx, 70, 1))).resolves.toBe(409);
    });
  });
});
