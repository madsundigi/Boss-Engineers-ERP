import { FatProtocolService } from '../src/modules/fatprotocol/fatprotocol.service';
import {
  FatProtocolRepository, DuplicateProtocolCodeError,
} from '../src/modules/fatprotocol/fatprotocol.repository';
import { RequestContext } from '../src/common/request-context';
import { FatProtocol, FatProtocolParam } from '../src/modules/fatprotocol/fatprotocol.types';

const ctx: RequestContext = {
  userId: 1, username: 'u', companyId: 1, buId: 1, clientIp: '', sessionId: '', permissions: new Set(),
};

const param = (o: Partial<FatProtocolParam> = {}): FatProtocolParam => ({
  paramId: 1, protocolId: 7, seq: 1, paramName: 'Coil temperature rise', specMin: 0, specMax: 80,
  uom: 'degC', ...o,
});
const proto = (o: Partial<FatProtocol> = {}): FatProtocol => ({
  protocolId: 7, companyId: 1, protocolCode: 'FAT-IH-01', protocolName: 'Induction Heater FAT',
  itemId: null, testType: 'FAT', isActive: true, ...o,
});

function make(over: Partial<FatProtocolRepository> = {}) {
  const repo = {
    create: jest.fn(async () => proto({ params: [param()] })),
    findById: jest.fn(async () => proto()),
    findByIdWithParams: jest.fn(async () => proto({ params: [param()] })),
    list: jest.fn(),
    update: jest.fn(async () => proto({ params: [param()] })),
    hardDelete: jest.fn(async () => true),
    ...over,
  } as unknown as FatProtocolRepository;
  return { svc: new FatProtocolService(repo), repo };
}

describe('FatProtocolService', () => {
  it('create delegates to the repository and threads the param lines', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, {
      protocolCode: 'FAT-IH-01', protocolName: 'Induction Heater FAT',
      params: [{ seq: 1, paramName: 'Coil temperature rise', specMin: 0, specMax: 80, uom: 'degC' }],
    });
    expect(repo.create).toHaveBeenCalled();
    // create(ctx, header, params): the param array is the 3rd arg.
    const paramsArg = (repo.create as jest.Mock).mock.calls[0][2];
    expect(paramsArg).toHaveLength(1);
    expect(paramsArg[0].paramName).toBe('Coil temperature rise');
  });

  it('create defaults to an empty checklist when params is omitted', async () => {
    const { svc, repo } = make();
    await svc.create(ctx, { protocolCode: 'FAT-IH-02', protocolName: 'No-line FAT' });
    const paramsArg = (repo.create as jest.Mock).mock.calls[0][2];
    expect(paramsArg).toEqual([]);
  });

  it('create maps a duplicate protocol_code to a 409 conflict', async () => {
    const { svc } = make({ create: jest.fn(async () => { throw new DuplicateProtocolCodeError(); }) });
    await expect(svc.create(ctx, { protocolCode: 'FAT-IH-01', protocolName: 'Dup' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('create rejects duplicate param seq values (400)', async () => {
    const { svc, repo } = make();
    await expect(svc.create(ctx, {
      protocolCode: 'FAT-IH-03', protocolName: 'Bad seq',
      params: [
        { seq: 1, paramName: 'A' },
        { seq: 1, paramName: 'B' },
      ],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create rejects an inverted spec band (min > max) (400)', async () => {
    const { svc } = make();
    await expect(svc.create(ctx, {
      protocolCode: 'FAT-IH-04', protocolName: 'Bad band',
      params: [{ seq: 1, paramName: 'Pressure', specMin: 10, specMax: 5 }],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('getById throws 404 when the protocol is missing', async () => {
    const { svc } = make({ findByIdWithParams: jest.fn(async () => null) });
    await expect(svc.getById(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getById returns the header with its nested param lines', async () => {
    const { svc } = make();
    const res = await svc.getById(ctx, 7);
    expect(res.protocolCode).toBe('FAT-IH-01');
    expect(res.params).toHaveLength(1);
    expect(res.params?.[0].seq).toBe(1);
  });

  it('update passes replacement params through to the repository', async () => {
    const { svc, repo } = make();
    await svc.update(ctx, 7, {
      protocolName: 'Renamed',
      params: [{ seq: 1, paramName: 'New line', uom: 'V' }],
    });
    const callParams = (repo.update as jest.Mock).mock.calls[0][3];
    expect(callParams).toHaveLength(1);
    expect(callParams[0].paramName).toBe('New line');
  });

  it('update leaves lines untouched when params is omitted (passes undefined)', async () => {
    const { svc, repo } = make();
    await svc.update(ctx, 7, { protocolName: 'Header only' });
    const callParams = (repo.update as jest.Mock).mock.calls[0][3];
    expect(callParams).toBeUndefined();
  });

  it('update throws 404 when the protocol is missing', async () => {
    const { svc } = make({ update: jest.fn(async () => null) });
    await expect(svc.update(ctx, 7, { protocolName: 'x' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete (hard) throws 404 when nothing was removed', async () => {
    const { svc } = make({ hardDelete: jest.fn(async () => false) });
    await expect(svc.delete(ctx, 7)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete succeeds when a row is removed', async () => {
    const { svc, repo } = make();
    await expect(svc.delete(ctx, 7)).resolves.toBeUndefined();
    expect(repo.hardDelete).toHaveBeenCalledWith(ctx, 7);
  });
});
