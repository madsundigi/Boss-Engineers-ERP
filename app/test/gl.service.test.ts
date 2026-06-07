import { GlService } from '../src/modules/gl/gl.service';
import { GlRepository, JournalInput } from '../src/modules/gl/gl.repository';
import { RequestContext } from '../src/common/request-context';
import { OutboxEventInput } from '../src/outbox/outbox';
import { GlAccount, JournalEntry } from '../src/modules/gl/gl.types';
import { GL_JOURNAL_POSTED_EVENT } from '../src/modules/gl/gl.constants';
import { AppError } from '../src/common/http-error';
import { PostJournalDto, PostCostDto } from '../src/modules/gl/gl.dto';

const ctx: RequestContext = {
  userId: 5, username: 'finance', companyId: 1, buId: 1,
  clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(),
};

function account(over: Partial<GlAccount> = {}): GlAccount {
  return { glId: 10, companyId: 1, glCode: '1000', glName: 'Cash', accountType: 'ASSET', isActive: true, ...over };
}

function journalEntry(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    glEntryId: 77, companyId: 1, buId: 1, postingDate: '2026-06-07',
    journalNo: 'JV/MUM/2026-27/000001', narration: null, sourceDocType: null,
    sourceDocId: null, createdBy: 5, createdAt: 't', lines: [], ...over,
  };
}

function makeRepo() {
  return {
    createAccount: jest.fn(),
    findAccount: jest.fn(),
    findAccountByCode: jest.fn(),
    listAccounts: jest.fn(),
    setActive: jest.fn(),
    findAccountsByIds: jest.fn(),
    postJournal: jest.fn(),
    findJournal: jest.fn(),
    listJournals: jest.fn(),
    trialBalance: jest.fn(),
    accountLedger: jest.fn(),
    postCost: jest.fn(),
    projectCostSummary: jest.fn(),
  } as unknown as jest.Mocked<GlRepository>;
}

/** Resolve a service call to its HTTP status code (0 on success). */
const code = (p: Promise<unknown>) => p.then(() => 0, (e: AppError) => e.statusCode);

/** A valid two-line balanced journal: debit Cash 100, credit Sales 100. */
function balanced(over: Partial<PostJournalDto> = {}): PostJournalDto {
  return {
    narration: 'Cash sale',
    lines: [
      { glId: 10, debit: 100 },
      { glId: 20, credit: 100 },
    ],
    ...over,
  };
}

describe('GlService', () => {
  let repo: jest.Mocked<GlRepository>;
  let service: GlService;
  beforeEach(() => {
    repo = makeRepo();
    service = new GlService(repo);
    // default: both referenced accounts exist and are active
    repo.findAccountsByIds.mockResolvedValue([
      { glId: 10, isActive: true },
      { glId: 20, isActive: true },
    ]);
    repo.postJournal.mockResolvedValue(journalEntry());
  });

  describe('createAccount', () => {
    it('creates an account when the code is free', async () => {
      repo.findAccountByCode.mockResolvedValue(null);
      const created = account();
      repo.createAccount.mockResolvedValue(created);
      const out = await service.createAccount(ctx, { glCode: '1000', glName: 'Cash', accountType: 'ASSET' });
      expect(out).toBe(created);
      expect(repo.createAccount).toHaveBeenCalledWith(ctx, expect.objectContaining({ glCode: '1000', isActive: true }));
    });

    it('rejects a duplicate gl_code (409)', async () => {
      repo.findAccountByCode.mockResolvedValue(account());
      expect(await code(service.createAccount(ctx, { glCode: '1000', glName: 'Cash', accountType: 'ASSET' }))).toBe(409);
      expect(repo.createAccount).not.toHaveBeenCalled();
    });
  });

  describe('getAccount / setActive', () => {
    it('404s an unknown account', async () => {
      repo.findAccount.mockResolvedValue(null);
      expect(await code(service.getAccount(ctx, 999))).toBe(404);
    });
    it('404s setActive on an unknown account', async () => {
      repo.setActive.mockResolvedValue(null);
      expect(await code(service.setActive(ctx, 999, false))).toBe(404);
    });
  });

  describe('postJournal — double-entry invariant', () => {
    it('posts a valid balanced journal: calls repo.post once and emits gl.journal.posted', async () => {
      const out = await service.postJournal(ctx, balanced());
      expect(out).toEqual(journalEntry());
      expect(repo.postJournal).toHaveBeenCalledTimes(1);
      const [, input, event] = repo.postJournal.mock.calls[0] as [RequestContext, JournalInput, OutboxEventInput];
      expect(input.totalDebit).toBe(100);
      expect(input.lines).toHaveLength(2);
      // each line is normalised to explicit debit/credit numbers
      expect(input.lines[0]).toMatchObject({ glId: 10, debit: 100, credit: 0 });
      expect(input.lines[1]).toMatchObject({ glId: 20, debit: 0, credit: 100 });
      expect(event.eventType).toBe(GL_JOURNAL_POSTED_EVENT);
      expect(event.payload).toMatchObject({ totalDebit: 100 });
    });

    it('rejects an unbalanced journal (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10, debit: 100 }, { glId: 20, credit: 90 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
      expect(repo.postJournal).not.toHaveBeenCalled();
    });

    it('rejects fewer than two lines (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10, debit: 100 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
      expect(repo.postJournal).not.toHaveBeenCalled();
    });

    it('rejects a line with BOTH a debit and a credit (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10, debit: 100, credit: 100 }, { glId: 20, credit: 100 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
    });

    it('rejects a line with NEITHER a debit nor a credit (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10 }, { glId: 20, credit: 100 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
    });

    it('rejects a zero-total journal (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10, debit: 0 }, { glId: 20, credit: 0 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
    });

    it('rejects a negative amount (400)', async () => {
      const dto = balanced({ lines: [{ glId: 10, debit: -100 }, { glId: 20, credit: -100 }] });
      expect(await code(service.postJournal(ctx, dto))).toBe(400);
    });

    it('rejects an unknown GL account (400)', async () => {
      repo.findAccountsByIds.mockResolvedValue([{ glId: 10, isActive: true }]); // 20 missing
      expect(await code(service.postJournal(ctx, balanced()))).toBe(400);
      expect(repo.postJournal).not.toHaveBeenCalled();
    });

    it('rejects an inactive GL account (409)', async () => {
      repo.findAccountsByIds.mockResolvedValue([
        { glId: 10, isActive: true },
        { glId: 20, isActive: false },
      ]);
      expect(await code(service.postJournal(ctx, balanced()))).toBe(409);
      expect(repo.postJournal).not.toHaveBeenCalled();
    });

    it('requires a branch / buId (400 when missing)', async () => {
      const noBu: RequestContext = { ...ctx, buId: null };
      expect(await code(service.postJournal(noBu, balanced()))).toBe(400);
      expect(repo.postJournal).not.toHaveBeenCalled();
    });

    it('balances a multi-line journal (2 debits == 1 credit)', async () => {
      repo.findAccountsByIds.mockResolvedValue([
        { glId: 10, isActive: true }, { glId: 20, isActive: true }, { glId: 30, isActive: true },
      ]);
      const dto = balanced({ lines: [
        { glId: 10, debit: 60 }, { glId: 30, debit: 40 }, { glId: 20, credit: 100 },
      ] });
      expect(await code(service.postJournal(ctx, dto))).toBe(0);
      expect(repo.postJournal).toHaveBeenCalledTimes(1);
    });
  });

  describe('getJournal', () => {
    it('404s an unknown journal', async () => {
      repo.findJournal.mockResolvedValue(null);
      expect(await code(service.getJournal(ctx, 12345))).toBe(404);
    });
    it('returns the journal header + lines when found', async () => {
      const j = journalEntry({ lines: [{ glId: 10, costCenterId: null, projectId: null, debit: 100, credit: 0 }] });
      repo.findJournal.mockResolvedValue(j);
      expect(await service.getJournal(ctx, 77)).toBe(j);
    });
  });

  describe('reverseJournal', () => {
    it('posts a mirror journal swapping debit<->credit', async () => {
      const original = journalEntry({ glEntryId: 5, journalNo: 'JV/MUM/2026-27/000005', lines: [
        { glId: 10, costCenterId: null, projectId: 7, debit: 100, credit: 0 },
        { glId: 20, costCenterId: null, projectId: null, debit: 0, credit: 100 },
      ] });
      repo.findJournal.mockResolvedValue(original);
      await service.reverseJournal(ctx, 5);
      expect(repo.postJournal).toHaveBeenCalledTimes(1);
      const [, input] = repo.postJournal.mock.calls[0] as [RequestContext, JournalInput, OutboxEventInput];
      // line 1 was a debit -> now a credit; line 2 was a credit -> now a debit
      expect(input.lines[0]).toMatchObject({ glId: 10, debit: 0, credit: 100 });
      expect(input.lines[1]).toMatchObject({ glId: 20, debit: 100, credit: 0 });
    });
  });

  describe('postCost', () => {
    const cost: PostCostDto = {
      projectId: 100, costType: 'MATERIAL', costStage: 'ACTUAL', amount: 5000,
      refDocType: 'GRN', refDocId: 42,
    };
    it('appends a cost row', async () => {
      const row = { costId: 1 } as never;
      repo.postCost.mockResolvedValue(row);
      const out = await service.postCost(ctx, cost);
      expect(out).toBe(row);
      expect(repo.postCost).toHaveBeenCalledWith(ctx, expect.objectContaining({
        projectId: 100, costType: 'MATERIAL', costStage: 'ACTUAL', amount: 5000, refDocType: 'GRN', refDocId: 42,
      }));
    });
    it('rejects a zero amount (400)', async () => {
      expect(await code(service.postCost(ctx, { ...cost, amount: 0 }))).toBe(400);
      expect(repo.postCost).not.toHaveBeenCalled();
    });
  });

  describe('accountLedger', () => {
    it('404s when the account does not exist', async () => {
      repo.findAccount.mockResolvedValue(null);
      expect(await code(service.accountLedger(ctx, 999, { page: 1, pageSize: 50 }))).toBe(404);
      expect(repo.accountLedger).not.toHaveBeenCalled();
    });
  });
});
