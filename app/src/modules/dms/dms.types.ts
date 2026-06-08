import { DocumentStatus, DocumentCategory } from './dms.constants';

/**
 * One immutable version of a document (camelCase projection of
 * dms.document_version). storageKey is the EXTERNAL object-store key/URL where the
 * file lives — this module stores the pointer + metadata, never the file body.
 */
export interface DocumentVersion {
  versionId: number;
  docId: number;
  versionNo: number;
  storageKey: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  notes: string | null;
  uploadedBy: number | null;
  uploadedAt: string;
}

/**
 * A persisted document with its version history (camelCase projection of
 * dms.document + dms.document_version, created in migration 038). currentVersion is
 * the latest version_no (0 until the first version is added).
 */
export interface DmsDocument {
  docId: number;
  docNo: string;
  companyId: number;
  buId: number | null;
  title: string;
  category: DocumentCategory | null;
  entityType: string | null;
  entityId: number | null;
  currentVersion: number;
  status: DocumentStatus;
  ownerId: number | null;
  createdAt: string;
  createdBy: number | null;
  updatedAt: string;
  rowVersion: number;
  versions: DocumentVersion[];
}

export interface DocumentListResult {
  rows: Omit<DmsDocument, 'versions'>[];
  total: number;
  page: number;
  pageSize: number;
}
