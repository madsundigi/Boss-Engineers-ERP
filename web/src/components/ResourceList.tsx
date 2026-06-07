import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { ResourceDef } from '../app/registry';

type Row = Record<string, unknown>;

const STATUS_MAP: Record<string, string> = {
  DRAFT: 'draft',
  PENDING: 'pending', SUBMITTED: 'pending', OPEN: 'pending', RCA: 'pending', CAPA: 'pending', HELD: 'pending', PLANNED: 'pending',
  ACTIVE: 'progress', IN_PROGRESS: 'progress', RELEASED: 'progress', ISSUED: 'progress', SENT: 'progress',
  PARTIALLY_PAID: 'progress', MATCHED: 'progress', COMMISSIONED: 'progress', PARTIAL: 'progress',
  APPROVED: 'approved', PASS: 'approved', PAID: 'approved', ACCEPTED: 'approved', VERIFIED: 'approved',
  RECEIVED: 'approved', DELIVERED: 'approved', ADJUSTED: 'approved',
  REJECTED: 'rejected', FAIL: 'rejected', CANCELLED: 'rejected', DISPUTED: 'rejected', LOST: 'rejected',
  CLOSED: 'closed', OBSOLETE: 'closed', IMPLEMENTED: 'closed', INACTIVE: 'closed',
  HOLD: 'hold', ON_HOLD: 'hold',
};
function badgeClass(v: string): string {
  return STATUS_MAP[v.toUpperCase()] ?? 'draft';
}

function extractRows(data: unknown): { rows: Row[]; total: number } {
  if (Array.isArray(data)) return { rows: data as Row[], total: data.length };
  const o = (data ?? {}) as Record<string, unknown>;
  const rows = (o.rows ?? o.items ?? o.data ?? []) as Row[];
  const total = typeof o.total === 'number' ? o.total : rows.length;
  return { rows, total };
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function deriveColumns(rows: Row[]): ResourceDef['columns'] {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]).filter((k) => isScalar(rows[0][k]));
  // surface an id / number column first, drop noisy audit fields, cap at 8.
  const priority = keys.filter((k) => /no$|^.*name$|status|date/i.test(k));
  const rest = keys.filter((k) => !priority.includes(k) && !/^(createdBy|updatedBy|isDeleted|rowVersion)$/.test(k));
  return [...priority, ...rest].slice(0, 8).map((k) => ({
    key: k,
    label: k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim(),
    kind: /amount|qty|total|value|hours|days|pct|count|debit|credit/i.test(k) ? 'num'
      : /status/i.test(k) ? 'status'
      : /no$|id$/i.test(k) ? 'mono' : undefined,
  }));
}

export function ResourceList({ def }: { def: ResourceDef }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get<unknown>(def.endpoint)
      .then((data) => { if (!live) return; const r = extractRows(data); setRows(r.rows); setTotal(r.total); })
      .catch((e: ApiError) => { if (live) setError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [def.endpoint]);

  const columns = (def.columns && def.columns.length ? def.columns : deriveColumns(rows)) ?? [];

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">{def.label}</h1>
      </div>

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403
            ? 'You do not have permission to view this (RBAC). Try a role that owns this module.'
            : `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`}
        </div>
      )}

      <div className="erp-table-wrap">
        <div className="erp-table-toolbar">
          <strong>{def.label}</strong>
          <span className="muted" style={{ marginLeft: 8 }}>{loading ? '' : `${total} record(s)`}</span>
        </div>
        {loading ? (
          <div className="spinner">Loading…</div>
        ) : (
          <table className="erp-table">
            <thead>
              <tr>{columns.map((c) => (
                <th key={c.key} className={c.kind === 'num' ? 'cell-num' : undefined}>{c.label}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={columns.length || 1} className="muted" style={{ padding: 16 }}>No records.</td></tr>
              )}
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => {
                    const v = row[c.key];
                    if (c.kind === 'status' && v != null) {
                      return <td key={c.key}><span className={`erp-badge erp-badge--${badgeClass(String(v))}`}>{String(v)}</span></td>;
                    }
                    const cls = c.kind === 'num' ? 'cell-num' : c.kind === 'mono' ? 'cell-mono' : undefined;
                    return <td key={c.key} className={cls}>{v == null ? '' : String(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
