import { Pool, QueryResultRow } from 'pg';
import { runInContext, runRead, Queryable } from '../../db/pool';
import { RequestContext } from '../../common/request-context';
import { DmsDocument, DocumentVersion, DocumentListResult } from './dms.types';
import { ListQueryDto } from './dms.dto';
import { DOC_TYPE, DocumentStatus } from './dms.constants';

/** Header columns of dms.document (created in migration 038). */
const H = `doc_id, doc_no, company_id, bu_id, title, category, entity_type, entity_id,
  current_version, status, owner_id, created_at, created_by, updated_at, row_version`;

/** Version columns of dms.document_version. */
const V = `version_id, doc_id, version_no, storage_key, file_name, mime_type,
  size_bytes, notes, uploaded_by, uploaded_at`;

type Header = Omit<DmsDocument, 'versions'>;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : (v as string);
}

function mapHeader(r: QueryResultRow): Header {
  return {
    docId: Number(r.doc_id),
    docNo: r.doc_no,
    companyId: Number(r.company_id),
    buId: r.bu_id == null ? null : Number(r.bu_id),
    title: r.title,
    category: r.category,
    entityType: r.entity_type,
    entityId: r.entity_id == null ? null : Number(r.entity_id),
    currentVersion: Number(r.current_version),
    status: r.status,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    createdAt: iso(r.created_at),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    updatedAt: iso(r.updated_at),
    rowVersion: Number(r.row_version),
  };
}
function mapVersion(r: QueryResultRow): DocumentVersion {
  return {
    versionId: Number(r.version_id),
    docId: Number(r.doc_id),
    versionNo: Number(r.version_no),
    storageKey: r.storage_key,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    notes: r.notes,
    uploadedBy: r.uploaded_by == null ? null : Number(r.uploaded_by),
    uploadedAt: iso(r.uploaded_at),
  };
}

/** Header fields the service supplies for create. */
export interface DocumentHeaderInput {
  title: string;
  category?: string;
  entityType?: string;
  entityId?: number;
  ownerId?: number;
}

/** Mutable header fields for a metadata edit (PATCH). */
export interface DocumentHeaderPatch {
  title?: string;
  category?: string;
  entityType?: string;
  entityId?: number;
  ownerId?: number;
}

/** A version the service has validated, ready to persist (storageKey is the
 *  EXTERNAL object-store pointer — the file body is uploaded by the client). */
export interface VersionInput {
  storageKey: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  notes?: string;
}

const COL_OF: Record<string, string> = {
  title: 'title', category: 'category', entityType: 'entity_type',
  entityId: 'entity_id', ownerId: 'owner_id',
};

export class DmsRepository {
  constructor(private readonly pool: Pool) {}

  private async fetchVersions(q: Queryable, id: number): Promise<DocumentVersion[]> {
    const res = await q.query(
      `SELECT ${V} FROM dms.document_version WHERE doc_id = $1 ORDER BY version_no`, [id]);
    return res.rows.map(mapVersion);
  }

  /** Insert a document (DRAFT, current_version 0), allocating the document number
   *  in the same transaction. company_id = ctx.companyId so the row passes RLS WITH CHECK. */
  async create(ctx: RequestContext, h: DocumentHeaderInput): Promise<DmsDocument> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `INSERT INTO dms.document
           (company_id, bu_id, doc_no, title, category, entity_type, entity_id,
            current_version, status, owner_id, created_by)
         VALUES ($1,$2, mdm.next_document_no($1,$2,'${DOC_TYPE}'),
                 $3,$4,$5,$6,0,'DRAFT',$7,$8)
         RETURNING ${H}`,
        [
          ctx.companyId, ctx.buId, h.title, h.category ?? null, h.entityType ?? null,
          h.entityId ?? null, h.ownerId ?? ctx.userId, ctx.userId,
        ]);
      return { ...mapHeader(res.rows[0]), versions: [] };
    });
  }

  async findById(ctx: RequestContext, id: number): Promise<DmsDocument | null> {
    return runRead(this.pool, ctx, async (c) => {
      const res = await c.query(
        `SELECT ${H} FROM dms.document
          WHERE doc_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), versions: await this.fetchVersions(c, id) };
    });
  }

  /** Versions of one document (scoped to the tenant via the parent header check). */
  async listVersions(ctx: RequestContext, id: number): Promise<DocumentVersion[] | null> {
    return runRead(this.pool, ctx, async (c) => {
      const head = await c.query(
        `SELECT 1 FROM dms.document WHERE doc_id = $1 AND company_id = $2 AND NOT is_deleted`,
        [id, ctx.companyId]);
      if (!head.rowCount) return null;
      return this.fetchVersions(c, id);
    });
  }

  async list(ctx: RequestContext, q: ListQueryDto): Promise<DocumentListResult> {
    const where: string[] = ['company_id = $1', 'NOT is_deleted'];
    const params: unknown[] = [ctx.companyId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    if (q.entityType) { params.push(q.entityType); where.push(`entity_type = $${params.length}`); }
    if (q.entityId) { params.push(q.entityId); where.push(`entity_id = $${params.length}`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`title ILIKE $${params.length}`); }
    const w = where.join(' AND ');
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC'; // q.sort/q.dir are enum-whitelisted
    const offset = (q.page - 1) * q.pageSize;

    return runRead(this.pool, ctx, async (c) => {
      const total = Number((await c.query<{ c: string }>(
        `SELECT count(*)::text c FROM dms.document WHERE ${w}`, params)).rows[0].c);
      const rows = await c.query(
        `SELECT ${H} FROM dms.document WHERE ${w}
          ORDER BY ${q.sort} ${dir}, doc_id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params);
      return { rows: rows.rows.map(mapHeader), total, page: q.page, pageSize: q.pageSize };
    });
  }

  /**
   * Add a version in ONE transaction: insert dms.document_version with
   * version_no = current_version + 1, then bump dms.document.current_version to
   * match. The optimistic-lock check is NOT used here (adding a version is additive
   * and serialised by the version_no unique constraint); the header row_version is
   * still bumped so the change is attributed + audited. Returns the refreshed
   * document, or null if the document was not found / not in the tenant.
   */
  async addVersion(ctx: RequestContext, id: number, v: VersionInput): Promise<DmsDocument | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const head = await c.query(
        `SELECT current_version FROM dms.document
          WHERE doc_id = $1 AND company_id = $2 AND NOT is_deleted FOR UPDATE`,
        [id, ctx.companyId]);
      if (!head.rowCount) return null;
      const nextNo = Number(head.rows[0].current_version) + 1;
      await c.query(
        `INSERT INTO dms.document_version
           (doc_id, version_no, storage_key, file_name, mime_type, size_bytes, notes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, nextNo, v.storageKey, v.fileName ?? null, v.mimeType ?? null,
         v.sizeBytes ?? null, v.notes ?? null, ctx.userId]);
      const upd = await c.query(
        `UPDATE dms.document
            SET current_version = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE doc_id = $3 AND company_id = $4 AND NOT is_deleted
        RETURNING ${H}`,
        [nextNo, ctx.userId, id, ctx.companyId]);
      return { ...mapHeader(upd.rows[0]), versions: await this.fetchVersions(c, id) };
    });
  }

  /** Optimistic-locked header metadata update (DRAFT / ACTIVE only — the service
   *  guards status). Returns null on a row-version mismatch. */
  async update(
    ctx: RequestContext, id: number, expectedVersion: number, patch: DocumentHeaderPatch,
  ): Promise<DmsDocument | null> {
    const set: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(v); set.push(`${COL_OF[k]} = $${params.length}`);
    }
    return runInContext(this.pool, ctx, async (c) => {
      params.push(ctx.userId); const pUser = params.length;
      params.push(id); const pId = params.length;
      params.push(ctx.companyId); const pCo = params.length;
      params.push(expectedVersion); const pVer = params.length;
      const res = await c.query(
        `UPDATE dms.document
            SET ${set.length ? set.join(', ') + ',' : ''}
                updated_by = $${pUser}, updated_at = now(), row_version = row_version + 1
          WHERE doc_id = $${pId} AND company_id = $${pCo} AND row_version = $${pVer} AND NOT is_deleted
        RETURNING ${H}`, params);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), versions: await this.fetchVersions(c, id) };
    });
  }

  /** Lifecycle status change under optimistic lock (no domain event — the DMS is a
   *  passive repository). Returns null on a row-version mismatch. */
  async updateStatus(
    ctx: RequestContext, id: number, expectedVersion: number, status: DocumentStatus,
  ): Promise<DmsDocument | null> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE dms.document
            SET status = $1, updated_by = $2, updated_at = now(), row_version = row_version + 1
          WHERE doc_id = $3 AND company_id = $4 AND row_version = $5 AND NOT is_deleted
        RETURNING ${H}`,
        [status, ctx.userId, id, ctx.companyId, expectedVersion]);
      if (!res.rowCount) return null;
      return { ...mapHeader(res.rows[0]), versions: await this.fetchVersions(c, id) };
    });
  }

  /** Soft delete under optimistic lock (service guards status). Returns true if a
   *  row was deleted. */
  async softDelete(ctx: RequestContext, id: number, expectedVersion: number): Promise<boolean> {
    return runInContext(this.pool, ctx, async (c) => {
      const res = await c.query(
        `UPDATE dms.document
            SET is_deleted = true, updated_by = $1, updated_at = now(), row_version = row_version + 1
          WHERE doc_id = $2 AND company_id = $3 AND row_version = $4 AND NOT is_deleted`,
        [ctx.userId, id, ctx.companyId, expectedVersion]);
      return (res.rowCount ?? 0) > 0;
    });
  }
}
