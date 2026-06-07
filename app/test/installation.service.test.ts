import { InstallationService } from '../src/modules/installation/installation.service';
import { InstallationRepository } from '../src/modules/installation/installation.repository';
import { RequestContext } from '../src/common/request-context';
import { Installation, PunchItem } from '../src/modules/installation/installation.types';
import { AppError } from '../src/common/http-error';

const ctx: RequestContext = {
  userId: 7, username: 'install', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function punch(over: Partial<PunchItem> = {}): PunchItem {
  return { punchId: 1, description: 'gap', severity: 'MINOR', status: 'OPEN', closedDate: null, ...over };
}

function installation(over: Partial<Installation> = {}): Installation {
  return {
    installId: 30, installNo: 'INST/MUM/2026-27/00030', companyId: 1, buId: 1,
    projectId: 100, dispatchId: 200, siteAddress: 'Plot 7, MIDC',
    plannedDate: '2026-06-10', actualDate: null, satResult: 'PENDING',
    acceptanceCertNo: null, acceptedDate: null, status: 'PLANNED',
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1,
    punchItems: [], ...over,
  };
}

function makeRepo() {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    update: jest.fn(),
    updateStatus: jest.fn(),
    softDelete: jest.fn(),
  } as unknown as jest.Mocked<InstallationRepository>;
}

const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

describe('InstallationService', () => {
  let repo: jest.Mocked<InstallationRepository>;
  let service: InstallationService;
  beforeEach(() => { repo = makeRepo(); service = new InstallationService(repo); });

  describe('create', () => {
    it('creates with branch context (status defaults PLANNED)', async () => {
      const created = installation();
      repo.create.mockResolvedValue(created);
      const out = await service.create(ctx, { projectId: 100, dispatchId: 200 });
      expect(out).toBe(created);
      expect(repo.create).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({ projectId: 100, dispatchId: 200 }),
        [],
      );
    });
    it('maps punch items into the repo call', async () => {
      repo.create.mockResolvedValue(installation());
      await service.create(ctx, {
        projectId: 100,
        punchItems: [{ description: 'door misaligned', status: 'OPEN' }],
      });
      const [, , punchArg] = repo.create.mock.calls[0];
      expect(punchArg).toEqual([
        { description: 'door misaligned', severity: null, status: 'OPEN', closedDate: null },
      ]);
    });
    it('rejects (400) when no branch context to allocate a number', async () => {
      await expect(code(service.create({ ...ctx, buId: null }, { projectId: 100 }))).resolves.toBe(400);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('404 when not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(code(service.getById(ctx, 99))).resolves.toBe(404);
    });
  });

  describe('start (PLANNED -> IN_PROGRESS)', () => {
    it('starts a PLANNED installation', async () => {
      repo.findById.mockResolvedValue(installation());
      repo.updateStatus.mockResolvedValue(installation({ status: 'IN_PROGRESS', rowVersion: 2 }));
      const out = await service.start(ctx, 30, 1);
      expect(out.status).toBe('IN_PROGRESS');
    });
    it('409 when not PLANNED', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED' }));
      await expect(code(service.start(ctx, 30, 1))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 on a stale row version', async () => {
      repo.findById.mockResolvedValue(installation());
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.start(ctx, 30, 1))).resolves.toBe(409);
    });
  });

  describe('commission (IN_PROGRESS -> COMMISSIONED, SAT outcome)', () => {
    it('stamps the SAT result and actual date', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'IN_PROGRESS' }));
      repo.updateStatus.mockResolvedValue(installation({ status: 'COMMISSIONED', satResult: 'PASS', rowVersion: 2 }));
      const out = await service.commission(ctx, 30, { satResult: 'PASS', actualDate: '2026-06-12', rowVersion: 1 });
      expect(out.satResult).toBe('PASS');
      const [, , , status, patch] = repo.updateStatus.mock.calls[0];
      expect(status).toBe('COMMISSIONED');
      expect(patch).toMatchObject({ sat_result: 'PASS', actual_date: '2026-06-12' });
    });
    it('records a FAIL SAT too (the test happened)', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'IN_PROGRESS' }));
      repo.updateStatus.mockResolvedValue(installation({ status: 'COMMISSIONED', satResult: 'FAIL', rowVersion: 2 }));
      const out = await service.commission(ctx, 30, { satResult: 'FAIL', rowVersion: 1 });
      expect(out.satResult).toBe('FAIL');
    });
    it('409 when not IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'PLANNED' }));
      await expect(code(service.commission(ctx, 30, { satResult: 'PASS', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('accept — gated on PASSED SAT + zero open punch items', () => {
    it('409 when the installation is not COMMISSIONED', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'IN_PROGRESS', satResult: 'PASS' }));
      await expect(code(service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when the SAT did not PASS (PENDING)', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED', satResult: 'PENDING' }));
      await expect(code(service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('409 when the SAT FAILED', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED', satResult: 'FAIL' }));
      await expect(code(service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', rowVersion: 1 }))).resolves.toBe(409);
    });
    it('409 when there are OPEN punch items, even with a PASSED SAT', async () => {
      repo.findById.mockResolvedValue(installation({
        status: 'COMMISSIONED', satResult: 'PASS',
        punchItems: [punch({ status: 'CLOSED' }), punch({ punchId: 2, status: 'OPEN' })],
      }));
      await expect(code(service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', rowVersion: 1 }))).resolves.toBe(409);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });
    it('accepts once SAT is PASS and all punch items are CLOSED, emitting installation.accepted', async () => {
      repo.findById.mockResolvedValue(installation({
        status: 'COMMISSIONED', satResult: 'PASS',
        punchItems: [punch({ status: 'CLOSED', closedDate: '2026-06-11' })],
      }));
      repo.updateStatus.mockResolvedValue(installation({
        status: 'ACCEPTED', satResult: 'PASS', acceptanceCertNo: 'AC-1', rowVersion: 2,
      }));
      const out = await service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', acceptedDate: '2026-06-13', rowVersion: 1 });
      expect(out.status).toBe('ACCEPTED');
      const [, , , status, patch, event] = repo.updateStatus.mock.calls[0];
      expect(status).toBe('ACCEPTED');
      expect(patch).toMatchObject({ acceptance_cert_no: 'AC-1', accepted_date: '2026-06-13' });
      expect(event).toMatchObject({
        eventType: 'installation.accepted', aggregateType: 'INSTALLATION', aggregateId: 30,
      });
      expect((event as { payload: Record<string, unknown> }).payload).toMatchObject({
        installNo: 'INST/MUM/2026-27/00030', projectId: 100, dispatchId: 200,
      });
    });
    it('409 on a stale row version even when the gate passes', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED', satResult: 'PASS' }));
      repo.updateStatus.mockResolvedValue(null);
      await expect(code(service.accept(ctx, 30, { acceptanceCertNo: 'AC-1', rowVersion: 1 }))).resolves.toBe(409);
    });
  });

  describe('close (ACCEPTED -> CLOSED)', () => {
    it('closes an ACCEPTED installation', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'ACCEPTED' }));
      repo.updateStatus.mockResolvedValue(installation({ status: 'CLOSED', rowVersion: 3 }));
      const out = await service.close(ctx, 30, 2);
      expect(out.status).toBe('CLOSED');
    });
    it('409 unless ACCEPTED', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED' }));
      await expect(code(service.close(ctx, 30, 1))).resolves.toBe(409);
    });
  });

  describe('update', () => {
    it('400 when nothing supplied to update', async () => {
      await expect(code(service.update(ctx, 30, { rowVersion: 1 }))).resolves.toBe(400);
    });
    it('allows edits in IN_PROGRESS', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'IN_PROGRESS' }));
      repo.update.mockResolvedValue(installation({ status: 'IN_PROGRESS', siteAddress: 'New site', rowVersion: 2 }));
      const out = await service.update(ctx, 30, { rowVersion: 1, siteAddress: 'New site' });
      expect(out.siteAddress).toBe('New site');
    });
    it('409 when COMMISSIONED (no longer editable)', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'COMMISSIONED' }));
      await expect(code(service.update(ctx, 30, { rowVersion: 1, siteAddress: 'x' }))).resolves.toBe(409);
    });
    it('409 on a row-version mismatch', async () => {
      repo.findById.mockResolvedValue(installation());
      repo.update.mockResolvedValue(null);
      await expect(code(service.update(ctx, 30, { rowVersion: 1, siteAddress: 'x' }))).resolves.toBe(409);
    });
  });

  describe('delete', () => {
    it('409 unless PLANNED', async () => {
      repo.findById.mockResolvedValue(installation({ status: 'IN_PROGRESS' }));
      await expect(code(service.delete(ctx, 30))).resolves.toBe(409);
    });
    it('soft-deletes a PLANNED installation', async () => {
      repo.findById.mockResolvedValue(installation());
      repo.softDelete.mockResolvedValue(true);
      await service.delete(ctx, 30);
      expect(repo.softDelete).toHaveBeenCalledWith(ctx, 30);
    });
  });
});
