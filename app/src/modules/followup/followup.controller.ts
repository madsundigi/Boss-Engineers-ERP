import { Request, Response } from 'express';
import { FollowupService } from './followup.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateFollowupDto, UpdateFollowupDto, ListQueryDto, DashboardQueryDto,
} from './followup.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

/** HTTP edge for the enquiry follow-up trail. */
export class FollowupController {
  constructor(private readonly service: FollowupService) {}

  list = async (req: Request, res: Response) => {
    const { enquiryId } = valid<ListQueryDto>(req, 'query');
    res.json(await this.service.listByEnquiry(ctxOf(req), enquiryId));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateFollowupDto>(req));
    res.status(201).json(created);
  };

  update = async (req: Request, res: Response) => {
    res.json(await this.service.update(ctxOf(req), idOf(req), valid<UpdateFollowupDto>(req)));
  };

  dashboard = async (req: Request, res: Response) => {
    const { mine } = valid<DashboardQueryDto>(req, 'query');
    res.json(await this.service.dashboard(ctxOf(req), mine));
  };
}
