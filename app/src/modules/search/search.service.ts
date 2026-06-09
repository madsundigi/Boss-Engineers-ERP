import { RequestContext } from '../../common/request-context';
import { SearchRepository } from './search.repository';
import { SearchEntityType, SearchGroup, SearchHit, SearchResults } from './search.types';

/** Repository surface the service depends on (lets the unit test inject a fake). */
export type SearchRepoLike = Pick<
  SearchRepository,
  | 'searchEnquiries'
  | 'searchQuotations'
  | 'searchProjects'
  | 'searchSerials'
  | 'searchServiceTickets'
  | 'searchCustomers'
>;

/**
 * One queryable entity group: its type, display label, the VIEW permission that
 * gates it (deny-by-default), and the repository call that fetches its hits.
 */
interface GroupSpec {
  type: SearchEntityType;
  label: string;
  perm: string;
  fetch: (ctx: RequestContext, q: string, limit: number) => Promise<SearchHit[]>;
}

/**
 * SearchService — assembles the global Central Search response (read-only). It is a
 * thin, stateless orchestrator over the repository. It runs ONLY the entity queries
 * the caller is permitted to see (each group gated on a per-module VIEW permission),
 * fetches them concurrently, drops empty groups, and totals the hits. It never writes
 * and never emits events; for a caller with no relevant permissions (or no matches)
 * it returns an empty `groups` array and `total: 0` — never throws.
 *
 * Per-group RBAC gates (the exact permission code each group requires):
 *   enquiry        -> ENQUIRY.VIEW
 *   quotation      -> QUOTATION.VIEW
 *   project        -> PROJECT.VIEW
 *   serial         -> DISPATCH.VIEW   (serials move through the dispatch lifecycle;
 *                                      SERVICE/STORES/SALES roles hold DISPATCH.VIEW)
 *   service_ticket -> SERVICE_TICKET.VIEW
 *   customer       -> CUSTOMER.VIEW   (the MDM customer-master read permission)
 */
export class SearchService {
  constructor(private readonly repo: SearchRepoLike) {}

  /** Every entity group, in the order it should appear in the response. */
  private groupSpecs(): GroupSpec[] {
    return [
      { type: 'enquiry', label: 'Enquiries', perm: 'ENQUIRY.VIEW',
        fetch: (ctx, q, l) => this.repo.searchEnquiries(ctx, q, l) },
      { type: 'quotation', label: 'Quotations', perm: 'QUOTATION.VIEW',
        fetch: (ctx, q, l) => this.repo.searchQuotations(ctx, q, l) },
      { type: 'project', label: 'Projects', perm: 'PROJECT.VIEW',
        fetch: (ctx, q, l) => this.repo.searchProjects(ctx, q, l) },
      { type: 'serial', label: 'Serial Numbers', perm: 'DISPATCH.VIEW',
        fetch: (ctx, q, l) => this.repo.searchSerials(ctx, q, l) },
      { type: 'service_ticket', label: 'Service Tickets', perm: 'SERVICE_TICKET.VIEW',
        fetch: (ctx, q, l) => this.repo.searchServiceTickets(ctx, q, l) },
      { type: 'customer', label: 'Customers', perm: 'CUSTOMER.VIEW',
        fetch: (ctx, q, l) => this.repo.searchCustomers(ctx, q, l) },
    ];
  }

  /** Run the permitted entity queries, assemble grouped hits (empty groups omitted). */
  async search(ctx: RequestContext, q: string, limit: number): Promise<SearchResults> {
    // Only query groups the caller may see (deny-by-default per-module VIEW perm).
    const permitted = this.groupSpecs().filter((g) => ctx.permissions.has(g.perm));

    const settled = await Promise.all(
      permitted.map(async (g) => ({ spec: g, hits: await g.fetch(ctx, q, limit) })),
    );

    const groups: SearchGroup[] = settled
      .filter((s) => s.hits.length > 0) // omit empty groups
      .map((s) => ({ type: s.spec.type, label: s.spec.label, hits: s.hits }));

    const total = groups.reduce((sum, g) => sum + g.hits.length, 0);
    return { query: q, groups, total };
  }
}
