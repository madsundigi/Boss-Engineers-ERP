import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { ResourceDef } from '../app/registry';

/** Map a status value to its `erp-badge--<variant>` modifier. Kept in sync with
 *  the map in ResourceList so inline-editable status cells colour identically to
 *  read-only ones. */
const STATUS_MAP: Record<string, string> = {
  DRAFT: 'draft',
  PENDING: 'pending', SUBMITTED: 'pending', OPEN: 'pending', RCA: 'pending', CAPA: 'pending', HELD: 'pending', PLANNED: 'pending',
  ACTIVE: 'progress', IN_PROGRESS: 'progress', RELEASED: 'progress', ISSUED: 'progress', SENT: 'progress',
  PARTIALLY_PAID: 'progress', MATCHED: 'progress', COMMISSIONED: 'progress', PARTIAL: 'progress',
  APPROVED: 'approved', PASS: 'approved', PAID: 'approved', ACCEPTED: 'approved', VERIFIED: 'approved',
  RECEIVED: 'approved', DELIVERED: 'approved', ADJUSTED: 'approved', WON: 'approved',
  REJECTED: 'rejected', FAIL: 'rejected', CANCELLED: 'rejected', DISPUTED: 'rejected', LOST: 'rejected',
  CLOSED: 'closed', OBSOLETE: 'closed', IMPLEMENTED: 'closed', INACTIVE: 'closed',
  HOLD: 'hold', ON_HOLD: 'hold',
};
function badgeClass(v: string): string {
  return STATUS_MAP[v.toUpperCase()] ?? 'draft';
}

/**
 * Inline, sequence-restricted status editor for a single row's status cell.
 * Renders the current status as a coloured badge; if the resource's
 * `statusEdit.transitions[current]` lists any allowed next states it also shows
 * a compact `<select>`. Choosing a next state (prompting for a reason first when
 * the target is in `reasonOn`) POSTs to `{endpoint}/{id}/status` with the row's
 * optimistic-lock `rowVersion`, then refreshes the list. Errors are surfaced via
 * the parent's `actionError` channel (`onError`).
 */
export function StatusCell({
  def, row, id, current, busy, onBusy, onError, onDone,
}: {
  def: ResourceDef;
  row: Record<string, unknown>;
  id: unknown;
  current: string;
  busy: boolean;
  onBusy: (id: unknown) => void;
  onError: (msg: string | null) => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const cfg = def.statusEdit!;
  const next = cfg.transitions[current.toUpperCase()] ?? [];
  const badge = <span className={`erp-badge erp-badge--${badgeClass(current)}`}>{current}</span>;

  // Terminal state (no allowed transitions) → read-only badge, no select.
  if (next.length === 0) return badge;

  async function change(status: string) {
    if (!status) return;
    let reason: string | undefined;
    if (cfg.reasonOn?.includes(status)) {
      const r = window.prompt(`Reason for marking ${status}?`);
      if (r == null || r.trim() === '') return; // cancelled or blank → abort
      reason = r.trim();
    }
    onError(null);
    onBusy(id);
    setSaving(true);
    try {
      await api.post(`${def.endpoint}/${encodeURIComponent(String(id))}/status`, {
        status,
        ...(reason !== undefined ? { reason } : {}),
        rowVersion: row.rowVersion,
      });
      onDone();
    } catch (err) {
      const a = err as ApiError;
      onError(
        a.status === 409 ? 'This record was changed by someone else — reload and try again.'
        : a.status === 403 ? 'You do not have permission to change this status.'
        : `${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`,
      );
    } finally {
      setSaving(false);
      onBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {badge}
      <select
        className="erp-select"
        style={{ width: 'auto', minWidth: 110 }}
        value=""
        disabled={busy || saving}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">{saving ? '…' : 'Change →'}</option>
        {next.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </div>
  );
}
