import { Request, Response } from 'express';
import { QualityService } from './quality.service';
import { valid } from '../../common/validate';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  CreateInspectionDto, RecordResultsDto, ListQueryDto, VersionDto,
  RegisterGaugeDto, RecordCalibrationDto, GaugeListQueryDto,
} from './quality.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}
function idOf(req: Request, name = 'id'): number {
  const id = Number(req.params[name]);
  if (!Number.isInteger(id) || id <= 0) throw Errors.badRequest(`Invalid ${name}`);
  return id;
}

export class QualityController {
  constructor(private readonly service: QualityService) {}

  // --- Inspections ---------------------------------------------------------
  list = async (req: Request, res: Response) => {
    res.json(await this.service.list(ctxOf(req), valid<ListQueryDto>(req, 'query')));
  };

  create = async (req: Request, res: Response) => {
    const created = await this.service.create(ctxOf(req), valid<CreateInspectionDto>(req));
    res.status(201).json(created);
  };

  getById = async (req: Request, res: Response) => {
    res.json(await this.service.getById(ctxOf(req), idOf(req)));
  };

  recordResults = async (req: Request, res: Response) => {
    res.json(await this.service.recordResults(ctxOf(req), idOf(req), valid<RecordResultsDto>(req)));
  };

  remove = async (req: Request, res: Response) => {
    await this.service.delete(ctxOf(req), idOf(req));
    res.status(204).send();
  };

  exportCsv = async (req: Request, res: Response) => {
    const csv = await this.service.exportCsv(ctxOf(req), valid<ListQueryDto>(req, 'query'));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inspections.csv"');
    res.send(csv);
  };

  // --- Calibration register ------------------------------------------------
  registerGauge = async (req: Request, res: Response) => {
    const created = await this.service.registerGauge(ctxOf(req), valid<RegisterGaugeDto>(req));
    res.status(201).json(created);
  };

  listGauges = async (req: Request, res: Response) => {
    res.json(await this.service.listGauges(ctxOf(req), valid<GaugeListQueryDto>(req, 'query')));
  };

  getGauge = async (req: Request, res: Response) => {
    res.json(await this.service.getGaugeById(ctxOf(req), idOf(req, 'gaugeId')));
  };

  recordCalibration = async (req: Request, res: Response) => {
    const out = await this.service.recordCalibration(ctxOf(req), idOf(req, 'gaugeId'), valid<RecordCalibrationDto>(req));
    res.status(201).json(out);
  };

  gaugeHistory = async (req: Request, res: Response) => {
    res.json(await this.service.gaugeHistory(ctxOf(req), idOf(req, 'gaugeId')));
  };
}
