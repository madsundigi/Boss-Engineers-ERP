import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { FollowupRepository } from './followup.repository';
import { Followup, FollowupListResult, FollowupDashboard } from './followup.types';
import { CreateFollowupDto, UpdateFollowupDto } from './followup.dto';

/**
 * FollowupService — business logic for the enquiry follow-up trail. Stateless;
 * depends only on the repository (injected) so it is unit-testable without a DB.
 */
export class FollowupService {
  constructor(private readonly repo: FollowupRepository) {}

  /** The trail for one enquiry (404 if the enquiry isn't in the tenant). */
  async listByEnquiry(ctx: RequestContext, enquiryId: number): Promise<FollowupListResult> {
    if (!(await this.repo.enquiryExists(ctx, enquiryId))) {
      throw Errors.notFound(`Enquiry ${enquiryId} not found`);
    }
    const rows = await this.repo.listByEnquiry(ctx, enquiryId);
    return { rows };
  }

  async getById(ctx: RequestContext, id: number): Promise<Followup> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Follow-up ${id} not found`);
    return row;
  }

  /** Log the next follow-up (404 if the parent enquiry doesn't exist). */
  async create(ctx: RequestContext, dto: CreateFollowupDto): Promise<Followup> {
    if (!(await this.repo.enquiryExists(ctx, dto.enquiryId))) {
      throw Errors.notFound(`Enquiry ${dto.enquiryId} not found`);
    }
    return this.repo.create(ctx, dto);
  }

  /** Close out / reschedule under optimistic concurrency (404 missing, 409 stale). */
  async update(ctx: RequestContext, id: number, dto: UpdateFollowupDto): Promise<Followup> {
    const { rowVersion, ...fields } = dto;
    if (Object.keys(fields).length === 0) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    const updated = await this.repo.update(ctx, id, rowVersion, fields);
    if (!updated) {
      throw Errors.conflict('Follow-up was modified by someone else (row version mismatch)', {
        expected: rowVersion,
        current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * The alerting dashboard: every PENDING follow-up (optionally only the caller's)
   * ordered by due date, plus a roll-up of the derived urgencies.
   */
  async dashboard(ctx: RequestContext, mine: boolean): Promise<FollowupDashboard> {
    const rows = await this.repo.dashboard(ctx, mine);
    const summary = { due: 0, upcoming: 0, missed: 0 };
    for (const r of rows) {
      if (r.urgency === 'DUE') summary.due += 1;
      else if (r.urgency === 'UPCOMING') summary.upcoming += 1;
      else if (r.urgency === 'MISSED') summary.missed += 1;
    }
    return { rows, summary };
  }
}
