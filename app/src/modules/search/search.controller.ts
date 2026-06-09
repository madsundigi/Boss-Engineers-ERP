import { Request, Response } from 'express';
import { SearchService } from './search.service';
import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import { valid } from '../../common/validate';
import { SearchQueryDto } from './search.dto';

function ctxOf(req: Request): RequestContext {
  if (!req.context) throw Errors.unauthorized();
  return req.context;
}

/** HTTP edge for the read-only Central Search module (no writes, no mutating verbs). */
export class SearchController {
  constructor(private readonly service: SearchService) {}

  // `q` and `limit` are already validated & coerced by validate(searchQuerySchema,'query').
  search = async (req: Request, res: Response) => {
    const { q, limit } = valid<SearchQueryDto>(req, 'query');
    res.json(await this.service.search(ctxOf(req), q, limit));
  };
}
