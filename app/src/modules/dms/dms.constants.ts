/** Domain constants for the Document Management System (DMS, FRD §11 Tier-2).
 *
 * A versioned document repository (drawings, specs, test certificates, contracts,
 * reports, manuals) with access control. A document is a HEADER (dms.document) that
 * carries metadata + a current_version pointer, plus an immutable VERSION history
 * (dms.document_version). Each version's storage_key is a POINTER into EXTERNAL
 * object storage (S3 / blob) — the file body itself is NOT stored here: the client
 * uploads the file to object storage and passes the resulting key/URL.
 *
 * This module emits NO domain events (no transactional-outbox wiring): it is a
 * passive repository of metadata, not a workflow that downstream consumers react to.
 */

/**
 * Document lifecycle (dms.document.status):
 *   DRAFT -> ACTIVE -> ARCHIVED   (+ OBSOLETE, reachable from any non-OBSOLETE state)
 * A document is created DRAFT (current_version 0). activate publishes it (requires at
 * least one version); archive supersedes a published document but keeps it readable;
 * a document can be re-activated from ARCHIVED. markObsolete retires it permanently.
 * OBSOLETE is terminal.
 */
export const DOCUMENT_STATUS = ['DRAFT', 'ACTIVE', 'ARCHIVED', 'OBSOLETE'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number];

/** Allowed lifecycle transitions. Deny anything not listed. */
export const STATUS_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  DRAFT: ['ACTIVE', 'OBSOLETE'],
  ACTIVE: ['ARCHIVED', 'OBSOLETE'],
  ARCHIVED: ['ACTIVE', 'OBSOLETE'],
  OBSOLETE: [], // terminal
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Document categories (dms.document.category) — the kind of document. Mirrors the
 * CHECK constraint in migration 038. Optional on a document (nullable).
 */
export const DOCUMENT_CATEGORY = [
  'DRAWING', 'SPEC', 'CERTIFICATE', 'CONTRACT', 'REPORT', 'MANUAL', 'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORY)[number];

/** Statuses from which a DRAFT-style header edit (title / category / entity link)
 *  is permitted. Once ARCHIVED / OBSOLETE the metadata is frozen. */
export const EDITABLE_STATUSES: DocumentStatus[] = ['DRAFT', 'ACTIVE'];

/**
 * RBAC permission codes for this module (the 'DOCUMENT' domain is seeded in
 * migration 038 — it is NOT in the db/08 catalog). Grants:
 *   ADMIN                          = VCEDAX (all six),
 *   PLANNING/PRODUCTION/QC/SALES   = VCE    (own documents: view/create/edit),
 *   SERVICE                        = VC     (view/create),
 *   PURCHASE/FINANCE/INSTALL/STORES= V      (read only),
 *   CEO                            = VX     (view + export).
 * create-doc + add-version -> DOCUMENT.CREATE; edit / status -> DOCUMENT.EDIT;
 * reads -> DOCUMENT.VIEW; soft-delete -> DOCUMENT.DELETE; CSV export -> DOCUMENT.EXPORT.
 * (APPROVE is granted to ADMIN for completeness; the lifecycle here uses EDIT.)
 */
export const DOCUMENT_PERMS = {
  VIEW: 'DOCUMENT.VIEW',
  CREATE: 'DOCUMENT.CREATE',
  EDIT: 'DOCUMENT.EDIT',
  DELETE: 'DOCUMENT.DELETE',
  APPROVE: 'DOCUMENT.APPROVE',
  EXPORT: 'DOCUMENT.EXPORT',
} as const;

/** Document-numbering type registered in mdm.numbering_rule (prefix 'DOC'). */
export const DOC_TYPE = 'DOCUMENT';
