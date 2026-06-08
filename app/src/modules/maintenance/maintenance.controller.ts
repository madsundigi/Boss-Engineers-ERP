import { Request, Response } from 'express';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { MaintenanceService } from './maintenance.service';
import {
  CreateAssetDto, UpdateAssetDto, SetAssetStatusDto, AssetListQueryDto,
  CreateWoDto, UpdateWoDto, VersionDto, WoListQueryDto,
} from './maintenance.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest('Invalid id');
  return id;
}

export class MaintenanceController {
  constructor(private readonly svc: MaintenanceService) {}

  // --- Assets ---
  createAsset = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.createAsset(ctxOf(req), valid<CreateAssetDto>(req)));
  };
  listAssets = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.listAssets(ctxOf(req), valid<AssetListQueryDto>(req, 'query')));
  };
  getAsset = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getAsset(ctxOf(req), idOf(req)));
  };
  updateAsset = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.updateAsset(ctxOf(req), idOf(req), valid<UpdateAssetDto>(req)));
  };
  setAssetStatus = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.setAssetStatus(ctxOf(req), idOf(req), valid<SetAssetStatusDto>(req)));
  };
  removeAsset = async (req: Request, res: Response): Promise<void> => {
    await this.svc.deleteAsset(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };

  // --- Work orders ---
  createWo = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.svc.createWo(ctxOf(req), valid<CreateWoDto>(req)));
  };
  exportWoCsv = async (req: Request, res: Response): Promise<void> => {
    const csv = await this.svc.exportWoCsv(ctxOf(req), valid<WoListQueryDto>(req, 'query'));
    res.type('text/csv').send(csv);
  };
  listWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.listWo(ctxOf(req), valid<WoListQueryDto>(req, 'query')));
  };
  getWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.getWo(ctxOf(req), idOf(req)));
  };
  updateWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.updateWo(ctxOf(req), idOf(req), valid<UpdateWoDto>(req)));
  };
  startWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.startWo(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  completeWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.completeWo(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  cancelWo = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.svc.cancelWo(ctxOf(req), idOf(req), valid<VersionDto>(req).rowVersion));
  };
  removeWo = async (req: Request, res: Response): Promise<void> => {
    await this.svc.deleteWo(ctxOf(req), idOf(req), valid<VersionDto>(req, 'query').rowVersion);
    res.status(204).end();
  };
}
