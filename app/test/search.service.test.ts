import { SearchService, SearchRepoLike } from '../src/modules/search/search.service';
import { RequestContext } from '../src/common/request-context';
import { SearchHit } from '../src/modules/search/search.types';

/** Build a RequestContext holding exactly the given permission codes. */
function ctxWith(perms: string[]): RequestContext {
  return {
    userId: 5, username: 'tester', companyId: 1, buId: 1,
    clientIp: '10.0.0.1', sessionId: 's', permissions: new Set(perms),
  };
}

/** Every per-group VIEW permission the search service knows about. */
const ALL_PERMS = [
  'ENQUIRY.VIEW', 'QUOTATION.VIEW', 'PROJECT.VIEW',
  'DISPATCH.VIEW', 'SERVICE_TICKET.VIEW', 'CUSTOMER.VIEW',
];

/** A single fake hit (the n-th) for a given group path. */
function hit(n: number, path: string | null): SearchHit {
  return { id: n, no: `NO-${n}`, title: `Title ${n}`, subtitle: 'OPEN', path };
}

/** A fully-mocked repository; each method resolves [] unless overridden per-test. */
function makeRepo(): jest.Mocked<SearchRepoLike> {
  return {
    searchEnquiries: jest.fn().mockResolvedValue([]),
    searchQuotations: jest.fn().mockResolvedValue([]),
    searchProjects: jest.fn().mockResolvedValue([]),
    searchSerials: jest.fn().mockResolvedValue([]),
    searchServiceTickets: jest.fn().mockResolvedValue([]),
    searchCustomers: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SearchRepoLike>;
}

describe('SearchService', () => {
  let repo: jest.Mocked<SearchRepoLike>;
  let service: SearchService;
  beforeEach(() => { repo = makeRepo(); service = new SearchService(repo); });

  describe('permission gating', () => {
    it('queries every entity group when the caller holds all VIEW permissions', async () => {
      await service.search(ctxWith(ALL_PERMS), 'acme', 8);
      expect(repo.searchEnquiries).toHaveBeenCalledWith(expect.anything(), 'acme', 8);
      expect(repo.searchQuotations).toHaveBeenCalledTimes(1);
      expect(repo.searchProjects).toHaveBeenCalledTimes(1);
      expect(repo.searchSerials).toHaveBeenCalledTimes(1);
      expect(repo.searchServiceTickets).toHaveBeenCalledTimes(1);
      expect(repo.searchCustomers).toHaveBeenCalledTimes(1);
    });

    it('does NOT query quotations when the caller lacks QUOTATION.VIEW (no quotation group)', async () => {
      // Hold everything EXCEPT QUOTATION.VIEW; give every permitted group a hit.
      const perms = ALL_PERMS.filter((p) => p !== 'QUOTATION.VIEW');
      repo.searchEnquiries.mockResolvedValue([hit(1, 'enquiries')]);
      repo.searchProjects.mockResolvedValue([hit(1, 'projects')]);
      repo.searchSerials.mockResolvedValue([hit(1, null)]);
      repo.searchServiceTickets.mockResolvedValue([hit(1, 'service-tickets')]);
      repo.searchCustomers.mockResolvedValue([hit(1, null)]);

      const res = await service.search(ctxWith(perms), 'acme', 8);

      expect(repo.searchQuotations).not.toHaveBeenCalled();
      expect(res.groups.map((g) => g.type)).not.toContain('quotation');
      // the other five groups are present
      expect(res.groups.map((g) => g.type).sort()).toEqual(
        ['customer', 'enquiry', 'project', 'serial', 'service_ticket'],
      );
    });

    it('queries NOTHING and returns an empty result when the caller has no relevant permissions', async () => {
      const res = await service.search(ctxWith(['DASHBOARD.VIEW']), 'acme', 8);
      expect(repo.searchEnquiries).not.toHaveBeenCalled();
      expect(repo.searchQuotations).not.toHaveBeenCalled();
      expect(repo.searchProjects).not.toHaveBeenCalled();
      expect(repo.searchSerials).not.toHaveBeenCalled();
      expect(repo.searchServiceTickets).not.toHaveBeenCalled();
      expect(repo.searchCustomers).not.toHaveBeenCalled();
      expect(res.groups).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.query).toBe('acme');
    });
  });

  describe('group assembly', () => {
    it('omits groups whose query returned no hits', async () => {
      // Permitted on enquiries + projects, but only enquiries has a hit.
      repo.searchEnquiries.mockResolvedValue([hit(1, 'enquiries'), hit(2, 'enquiries')]);
      repo.searchProjects.mockResolvedValue([]);
      const res = await service.search(ctxWith(['ENQUIRY.VIEW', 'PROJECT.VIEW']), 'x', 8);

      expect(repo.searchProjects).toHaveBeenCalledTimes(1); // queried...
      expect(res.groups).toHaveLength(1);                   // ...but omitted (empty)
      expect(res.groups[0].type).toBe('enquiry');
      expect(res.groups[0].label).toBe('Enquiries');
      expect(res.groups[0].hits).toHaveLength(2);
    });

    it('total equals the sum of hits across all groups', async () => {
      repo.searchEnquiries.mockResolvedValue([hit(1, 'enquiries'), hit(2, 'enquiries')]); // 2
      repo.searchProjects.mockResolvedValue([hit(1, 'projects')]);                        // 1
      repo.searchCustomers.mockResolvedValue([hit(1, null), hit(2, null), hit(3, null)]); // 3

      const res = await service.search(
        ctxWith(['ENQUIRY.VIEW', 'PROJECT.VIEW', 'CUSTOMER.VIEW']), 'x', 8);

      expect(res.total).toBe(6);
      expect(res.total).toBe(res.groups.reduce((s, g) => s + g.hits.length, 0));
    });

    it('preserves the canonical group ordering', async () => {
      repo.searchEnquiries.mockResolvedValue([hit(1, 'enquiries')]);
      repo.searchServiceTickets.mockResolvedValue([hit(1, 'service-tickets')]);
      repo.searchCustomers.mockResolvedValue([hit(1, null)]);
      const res = await service.search(
        ctxWith(['CUSTOMER.VIEW', 'SERVICE_TICKET.VIEW', 'ENQUIRY.VIEW']), 'x', 8);
      // enquiry precedes service_ticket precedes customer regardless of permission order.
      expect(res.groups.map((g) => g.type)).toEqual(['enquiry', 'service_ticket', 'customer']);
    });
  });
});
