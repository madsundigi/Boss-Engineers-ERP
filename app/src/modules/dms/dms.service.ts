import { Errors } from '../../common/http-error';
import { RequestContext } from '../../common/request-context';
import {
  DmsRepository, DocumentHeaderInput, DocumentHeaderPatch, VersionInput,
} from './dms.repository';
import { DmsDocument, DocumentVersion, DocumentListResult } from './dms.types';
import {
  CreateDocumentDto, AddVersionDto, UpdateDocumentDto, ListQueryDto,
} from './dms.dto';
import { canTransition, EDITABLE_STATUSES } from './dms.constants';

/**
 * DmsService — business logic for the Document Management System. Stateless;
 * depends only on the injected repository so it is unit-testable without a database.
 * Lifecycle DRAFT -> ACTIVE -> ARCHIVED (+ OBSOLETE). This module emits NO domain
 * events: it is a passive, versioned repository of document METADATA. The actual
 * file bytes live in EXTERNAL object storage (S3 / blob) — the client uploads the
 * file and supplies the resulting storageKey; addVersion records only that pointer.
 */
export class DmsService {
  constructor(private readonly repo: DmsRepository) {}

  /** Register a document in DRAFT (current_version 0). Requires a branch (x-bu-id)
   *  to allocate the document number. */
  async create(ctx: RequestContext, dto: CreateDocumentDto): Promise<DmsDocument> {
    if (!ctx.buId) {
      throw Errors.badRequest('A branch (x-bu-id) is required to allocate a document number');
    }
    const header: DocumentHeaderInput = {
      title: dto.title,
      category: dto.category,
      entityType: dto.entityType,
      entityId: dto.entityId,
      ownerId: dto.ownerId,
    };
    return this.repo.create(ctx, header);
  }

  async getById(ctx: RequestContext, id: number): Promise<DmsDocument> {
    const row = await this.repo.findById(ctx, id);
    if (!row) throw Errors.notFound(`Document ${id} not found`);
    return row;
  }

  list(ctx: RequestContext, query: ListQueryDto): Promise<DocumentListResult> {
    return this.repo.list(ctx, query);
  }

  async listVersions(ctx: RequestContext, id: number): Promise<DocumentVersion[]> {
    const versions = await this.repo.listVersions(ctx, id);
    if (versions === null) throw Errors.notFound(`Document ${id} not found`);
    return versions;
  }

  /**
   * Add a new version. The client has already uploaded the file to EXTERNAL object
   * storage and passes the storageKey; in one transaction the repository inserts the
   * version (version_no = current_version + 1) and bumps the document's
   * current_version. Blocked on an OBSOLETE document (it is retired).
   */
  async addVersion(ctx: RequestContext, id: number, dto: AddVersionDto): Promise<DmsDocument> {
    const existing = await this.getById(ctx, id); // 404 if missing
    if (existing.status === 'OBSOLETE') {
      throw Errors.conflict('Cannot add a version to an OBSOLETE document');
    }
    const input: VersionInput = {
      storageKey: dto.storageKey,
      fileName: dto.fileName,
      mimeType: dto.mimeType,
      sizeBytes: dto.sizeBytes,
      notes: dto.notes,
    };
    const updated = await this.repo.addVersion(ctx, id, input);
    if (!updated) throw Errors.notFound(`Document ${id} not found`);
    return updated;
  }

  async update(ctx: RequestContext, id: number, dto: UpdateDocumentDto): Promise<DmsDocument> {
    const { rowVersion, ...patch } = dto;
    if (Object.values(patch).every((v) => v === undefined)) {
      throw Errors.badRequest('No fields supplied to update');
    }
    const existing = await this.getById(ctx, id); // 404 if missing
    if (!EDITABLE_STATUSES.includes(existing.status)) {
      throw Errors.conflict(`Only a DRAFT or ACTIVE document can be edited (current: ${existing.status})`);
    }
    const updated = await this.repo.update(ctx, id, rowVersion, patch as DocumentHeaderPatch);
    if (!updated) {
      throw Errors.conflict('Document was modified by someone else (row version mismatch)', {
        expected: rowVersion, current: existing.rowVersion,
      });
    }
    return updated;
  }

  /**
   * Activate a document (DRAFT / ARCHIVED -> ACTIVE) — publishes it. Requires at
   * least one version (you cannot publish a document with no file behind it).
   */
  async activate(ctx: RequestContext, id: number, rowVersion: number): Promise<DmsDocument> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ACTIVE')) {
      throw Errors.conflict(`Cannot activate a ${existing.status} document`);
    }
    if (existing.currentVersion < 1) {
      throw Errors.conflict('A document needs at least one version before it can be activated');
    }
    return this.transition(ctx, id, rowVersion, 'ACTIVE');
  }

  /** Archive a published document (ACTIVE -> ARCHIVED) — supersede but keep readable. */
  async archive(ctx: RequestContext, id: number, rowVersion: number): Promise<DmsDocument> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'ARCHIVED')) {
      throw Errors.conflict(`Cannot archive a ${existing.status} document`);
    }
    return this.transition(ctx, id, rowVersion, 'ARCHIVED');
  }

  /** Retire a document permanently (any non-OBSOLETE -> OBSOLETE). Terminal. */
  async markObsolete(ctx: RequestContext, id: number, rowVersion: number): Promise<DmsDocument> {
    const existing = await this.getById(ctx, id);
    if (!canTransition(existing.status, 'OBSOLETE')) {
      throw Errors.conflict(`Cannot mark a ${existing.status} document obsolete`);
    }
    return this.transition(ctx, id, rowVersion, 'OBSOLETE');
  }

  private async transition(
    ctx: RequestContext, id: number, rowVersion: number,
    to: 'ACTIVE' | 'ARCHIVED' | 'OBSOLETE',
  ): Promise<DmsDocument> {
    const updated = await this.repo.updateStatus(ctx, id, rowVersion, to);
    if (!updated) throw Errors.conflict('Document was modified by someone else (row version mismatch)');
    return updated;
  }

  async delete(ctx: RequestContext, id: number, rowVersion: number): Promise<void> {
    await this.getById(ctx, id); // 404 if missing
    const ok = await this.repo.softDelete(ctx, id, rowVersion);
    if (!ok) throw Errors.conflict('Document was modified by someone else (row version mismatch)');
  }

  /** DOCUMENT.EXPORT — CSV of the (filtered) list. */
  async exportCsv(ctx: RequestContext, query: ListQueryDto): Promise<string> {
    const { rows } = await this.repo.list(ctx, { ...query, page: 1, pageSize: 200 });
    const head = [
      'Doc No', 'Title', 'Category', 'Status', 'Current Version',
      'Entity Type', 'Entity Id', 'Owner', 'Created',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.docNo, r.title, r.category, r.status, r.currentVersion,
      r.entityType, r.entityId, r.ownerId, r.createdAt,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }
}
