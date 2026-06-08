import { DmsService } from '../src/modules/dms/dms.service';
import { DmsRepository } from '../src/modules/dms/dms.repository';
import { RequestContext } from '../src/common/request-context';
import { DmsDocument, DocumentVersion } from '../src/modules/dms/dms.types';

const ctx: RequestContext = {
  userId: 7, username: 'planner', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function version(over: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    versionId: 100, docId: 40, versionNo: 1, storageKey: 's3://bucket/key-v1.pdf',
    fileName: 'drawing.pdf', mimeType: 'application/pdf', sizeBytes: 1024,
    notes: null, uploadedBy: 7, uploadedAt: 't', ...over,
  };
}

function doc(over: Partial<DmsDocument> = {}): DmsDocument {
  return {
    docId: 40, docNo: 'DOC/MUM/2026-27/000040', companyId: 1, buId: 1,
    title: 'GA Drawing', category: 'DRAWING', entityType: 'PROJECT', entityId: 9,
    currentVersion: 0, status: 'DRAFT', ownerId: 7,
    createdAt: 't', createdBy: 7, updatedAt: 't', rowVersion: 1,
    versions: [], ...over,
  };
}

function make(over: Partial<DmsRepository> = {}) {
  const repo = {
    create: jest.fn(async () => doc()),
    findById: jest.fn(async () => doc()),
    listVersions: jest.fn(async () => []),
    list: jest.fn(),
    addVersion: jest.fn(async () => doc({ currentVersion: 1, versions: [version()] })),
    update: jest.fn(async () => doc()),
    updateStatus: jest.fn(async () => doc()),
    softDelete: jest.fn(async () => true),
    ...over,
  } as unknown as DmsRepository;
  return { svc: new DmsService(repo), repo };
}

describe('DmsService', () => {
  it('create registers a DRAFT document with current_version 0', async () => {
    const { svc, repo } = make();
    const out = await svc.create(ctx, { title: 'GA Drawing', category: 'DRAWING' });
    expect(repo.create).toHaveBeenCalled();
    expect(out.status).toBe('DRAFT');
    expect(out.currentVersion).toBe(0);
  });

  it('create requires a branch (x-bu-id) to allocate the number (400)', async () => {
    const { svc } = make();
    await expect(svc.create({ ...ctx, buId: null }, { title: 'X' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('getById throws 404 when missing', async () => {
    const { svc } = make({ findById: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 40)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('addVersion increments current_version and records the version', async () => {
    const { svc, repo } = make();
    const out = await svc.addVersion(ctx, 40, { storageKey: 's3://bucket/key-v1.pdf' });
    expect(repo.addVersion).toHaveBeenCalledWith(ctx, 40, expect.objectContaining({
      storageKey: 's3://bucket/key-v1.pdf',
    }));
    expect(out.currentVersion).toBe(1);
    expect(out.versions).toHaveLength(1);
  });

  it('addVersion is blocked on an OBSOLETE document (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => doc({ status: 'OBSOLETE' })) });
    await expect(svc.addVersion(ctx, 40, { storageKey: 's3://x' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('activate is blocked without at least one version (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => doc({ status: 'DRAFT', currentVersion: 0 })) });
    await expect(svc.activate(ctx, 40, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('activate DRAFT->ACTIVE once a version exists', async () => {
    const { svc, repo } = make({
      findById: jest.fn(async () => doc({ status: 'DRAFT', currentVersion: 1 })),
      updateStatus: jest.fn(async () => doc({ status: 'ACTIVE', currentVersion: 1 })),
    });
    const out = await svc.activate(ctx, 40, 1);
    expect(repo.updateStatus).toHaveBeenCalledWith(ctx, 40, 1, 'ACTIVE');
    expect(out.status).toBe('ACTIVE');
  });

  it('activate from ACTIVE is rejected (409, not a legal transition)', async () => {
    const { svc } = make({ findById: jest.fn(async () => doc({ status: 'ACTIVE', currentVersion: 2 })) });
    await expect(svc.activate(ctx, 40, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('archive ACTIVE->ARCHIVED', async () => {
    const { svc, repo } = make({
      findById: jest.fn(async () => doc({ status: 'ACTIVE', currentVersion: 1 })),
      updateStatus: jest.fn(async () => doc({ status: 'ARCHIVED', currentVersion: 1 })),
    });
    await svc.archive(ctx, 40, 1);
    expect(repo.updateStatus).toHaveBeenCalledWith(ctx, 40, 1, 'ARCHIVED');
  });

  it('update is blocked on an ARCHIVED document (409)', async () => {
    const { svc } = make({ findById: jest.fn(async () => doc({ status: 'ARCHIVED' })) });
    await expect(svc.update(ctx, 40, { title: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('update returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 40, { title: 'x', rowVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('delete returns 409 on a row-version mismatch', async () => {
    const { svc } = make({ softDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 40, 1)).rejects.toMatchObject({ statusCode: 409 });
  });
});
