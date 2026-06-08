import { Request, Response } from 'express';
import { NotificationService } from './notification.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { RaiseNotificationDto, BroadcastNotificationDto, ListQueryDto } from './notification.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  // The caller's own notifications (newest first, paginated, + unreadCount).
  listMine = async (req: Request, res: Response) => {
    res.json(await this.service.listMine(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  raise = async (req: Request, res: Response) => {
    const created = await this.service.raise(ctxOf(req), valid<RaiseNotificationDto>(req));
    res.status(201).json(created);
  };

  broadcast = async (req: Request, res: Response) => {
    const result = await this.service.broadcast(ctxOf(req), valid<BroadcastNotificationDto>(req));
    res.status(201).json(result);
  };

  markRead = async (req: Request, res: Response) => {
    res.json(await this.service.markRead(ctxOf(req), idOf(req)));
  };

  markAllRead = async (req: Request, res: Response) => {
    res.json(await this.service.markAllRead(ctxOf(req)));
  };
}
