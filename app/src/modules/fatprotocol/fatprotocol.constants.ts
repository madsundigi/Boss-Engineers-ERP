/**
 * Domain constants for the FAT Protocol master-data module (M10 Quality / FAT).
 *
 * A FAT protocol (qms.fat_protocol) is the reusable test checklist applied during
 * Factory / Site Acceptance Testing. It is a header (protocol_code unique per the
 * whole table, protocol_name, optional item link, test_type FAT|SAT, is_active)
 * plus a list of repeatable parameter lines (qms.fat_protocol_param: an ordered
 * seq, a param_name, an optional spec_min/spec_max band and uom). The protocol is
 * master data that fat executions (qms.fat_execution — a DIFFERENT, run-time
 * record handled by the `fat/` module) reference; this module owns only the
 * checklist definition.
 *
 * Schema note: qms.fat_protocol has NO row_version, NO is_deleted and NO audit
 * columns (unlike most masters). So this module does NOT do optimistic concurrency
 * and DELETE is a HARD delete (the ON DELETE CASCADE on fat_protocol_param removes
 * the lines with it). The protocol_code UNIQUE is table-wide (not per company),
 * so a duplicate code maps to a 409 regardless of tenant.
 */

/** Allowed test-protocol types (ck_protocol_type on qms.fat_protocol). */
export const TEST_TYPES = ['FAT', 'SAT'] as const;
export type TestType = (typeof TEST_TYPES)[number];

/** Default test_type when a create omits it (matches the column DEFAULT 'FAT'). */
export const DEFAULT_TEST_TYPE: TestType = 'FAT';

/**
 * RBAC permission codes for this module. A FAT protocol is FAT master data, so it
 * reuses the existing 'FAT' domain seeded in db/08_rbac.sql (no new domain/migration).
 * Grants there: QC = VCEDAX (owns it), CEO = VX, and SALES/PRODUCTION/PLANNING/
 * INSTALL/ADMIN = V (read only). create -> FAT.CREATE; header/lines update ->
 * FAT.EDIT; reads -> FAT.VIEW; hard delete -> FAT.DELETE.
 */
export const FAT_PERMS = {
  VIEW: 'FAT.VIEW',
  CREATE: 'FAT.CREATE',
  EDIT: 'FAT.EDIT',
  DELETE: 'FAT.DELETE',
} as const;
