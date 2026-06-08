import { Request, Response } from 'express';
import { PortalService } from './portal.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { RaiseTicketDto } from './portal.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

/** HTTP edge for the Customer / Vendor Portal. Reads return arrays/objects;
 *  raise-ticket returns 201; acknowledge-PO returns the refreshed PO (200). */
export class PortalController {
  constructor(private readonly service: PortalService) {}

  me = async (req: Request, res: Response) => {
    res.json(await this.service.getIdentity(ctxOf(req)));
  };

  // --- customer ---
  projects = async (req: Request, res: Response) => {
    res.json(await this.service.getProjects(ctxOf(req)));
  };

  dispatches = async (req: Request, res: Response) => {
    res.json(await this.service.getDispatches(ctxOf(req)));
  };

  invoices = async (req: Request, res: Response) => {
    res.json(await this.service.getInvoices(ctxOf(req)));
  };

  tickets = async (req: Request, res: Response) => {
    res.json(await this.service.getTickets(ctxOf(req)));
  };

  raiseTicket = async (req: Request, res: Response) => {
    const created = await this.service.raiseTicket(ctxOf(req), valid<RaiseTicketDto>(req));
    res.status(201).json(created);
  };

  // --- vendor ---
  purchaseOrders = async (req: Request, res: Response) => {
    res.json(await this.service.getPurchaseOrders(ctxOf(req)));
  };

  grns = async (req: Request, res: Response) => {
    res.json(await this.service.getGrns(ctxOf(req)));
  };

  payments = async (req: Request, res: Response) => {
    res.json(await this.service.getPayments(ctxOf(req)));
  };

  acknowledgePurchaseOrder = async (req: Request, res: Response) => {
    res.json(await this.service.acknowledgePurchaseOrder(ctxOf(req), idOf(req)));
  };
}
