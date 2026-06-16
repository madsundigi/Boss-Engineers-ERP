import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { ResourceDef, RowActionDef, formFor, docFormFor, idOf, DocFormDef, FormField } from '../app/registry';
import { ResourceForm } from './ResourceForm';
import { RowActionModals, ModalAction } from './RowActionModals';

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

function deriveColumns(rows: Row[]): NonNullable<ResourceDef['columns']> {
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

/** Map a row to stringified header values for the edit form. Date fields are
 *  truncated to YYYY-MM-DD so they populate the native date input. */
function rowToValues(row: Row, fields: FormField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = row[f.name];
    if (v == null) continue;
    const s = String(v);
    out[f.name] = f.type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
  }
  return out;
}

/** Map a row's nested line array to stringified per-cell values for the editor. */
function rowToLines(row: Row, doc: DocFormDef): Record<string, string>[] {
  const arr = row[doc.lineKey];
  if (!Array.isArray(arr)) return [];
  return (arr as Row[]).map((ln) => {
    const out: Record<string, string> = {};
    for (const f of doc.lineFields) {
      const v = ln[f.name];
      if (v == null) continue;
      out[f.name] = String(v);
    }
    return out;
  });
}

export function ResourceList({ def }: { def: ResourceDef }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<unknown>(null);
  const [modalAction, setModalAction] = useState<ModalAction | null>(null);
  const form = formFor(def.path);
  const doc = docFormFor(def.path);
  const navigate = useNavigate();

  // Open the edit modal for a row. List endpoints return header-only rows, so
  // for line-item documents we fetch the full record (header + lines) first.
  async function openEdit(row: Row) {
    setActionError(null);
    if (!doc) { setEditRow(row); return; }
    const id = idOf(row, def);
    if (id == null) { setEditRow(row); return; }
    setBusyId(id);
    try {
      const full = await api.get<Row>(`${def.endpoint}/${encodeURIComponent(String(id))}`);
      setEditRow({ ...row, ...full });
    } catch {
      // fall back to the list row (lines may be empty) rather than blocking edit
      setEditRow(row);
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get<unknown>(def.endpoint)
      .then((data) => { if (!live) return; const r = extractRows(data); setRows(r.rows); setTotal(r.total); })
      .catch((e: ApiError) => { if (live) setError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [def.endpoint, reload]);

  const columns = (def.columns && def.columns.length ? def.columns : deriveColumns(rows)) ?? [];
  const refresh = () => setReload((n) => n + 1);

  async function handleDelete(row: Row) {
    const id = idOf(row, def);
    if (id == null) { setActionError('Could not determine the record id to delete.'); return; }
    if (!window.confirm(`Delete this ${def.label} record (#${String(id)})? This cannot be undone.`)) return;
    setActionError(null);
    setBusyId(id);
    const rv = row.rowVersion;
    const qs = rv != null ? `?rowVersion=${encodeURIComponent(String(rv))}` : '';
    try {
      await api.del(`${def.endpoint}/${encodeURIComponent(String(id))}${qs}`);
      refresh();
    } catch (err) {
      const a = err as ApiError;
      setActionError(
        a.status === 409 ? 'This record was changed by someone else — reload and try again.'
        : a.status === 403 ? 'You do not have permission to delete this record.'
        : `${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  // Modal row-actions ('assignPerson' / 'followups') open an in-place modal
  // instead of hitting an API path; API kinds fall through to runAction.
  function clickAction(row: Row, action: RowActionDef) {
    if (action.kind === 'assignPerson' || action.kind === 'followups') {
      const id = idOf(row, def);
      if (id == null) { setActionError('Could not determine the enquiry id for this action.'); return; }
      setActionError(null);
      setModalAction({ kind: action.kind, id, row });
      return;
    }
    void runAction(row, action);
  }

  // One-click "carry forward": create the next document from this row, then
  // jump to that document's list so the user sees the result immediately.
  async function runAction(row: Row, action: RowActionDef) {
    const id = idOf(row, def);
    if (id == null) { setActionError('Could not determine the record id for this action.'); return; }
    const sid = encodeURIComponent(String(id));
    setActionError(null);
    setBusyId(id);
    try {
      if (action.kind === 'enquiryToQuote') {
        // Convert requires a QUALIFIED enquiry — auto-qualify a NEW one first.
        if (String(row.status ?? '').toUpperCase() === 'NEW') {
          await api.post(`/api/enquiries/${sid}/approve`, { rowVersion: row.rowVersion });
        }
        await api.post(`/api/quotations/from-enquiry/${sid}`, {});
        navigate('/r/quotations');
      } else if (action.kind === 'receivePo') {
        await api.post(`/api/procurement/purchase-orders/${sid}/receive`, {});
        navigate('/r/grn');
      } else if (action.kind === 'invoiceFromProject') {
        await api.post(`/api/invoices/from-project/${sid}`, {});
        navigate('/r/invoices');
      }
    } catch (err) {
      const a = err as ApiError;
      setActionError(
        a.status === 409 ? (a.message || 'This record is not in a state that allows this action.')
        : a.status === 403 ? 'You do not have permission to perform this action.'
        : `${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function submitCreate(payload: Record<string, unknown>) {
    await api.post(def.endpoint, payload);
  }
  function submitEdit(row: Row) {
    return async (payload: Record<string, unknown>) => {
      const id = idOf(row, def);
      const body = { ...payload, rowVersion: row.rowVersion };
      await api.patch(`${def.endpoint}/${encodeURIComponent(String(id))}`, body);
    };
  }

  const rowActions = def.rowActions ?? [];
  // resources with a create form get edit/delete; carry-forward buttons add their own column too
  const showActions = !!form || rowActions.length > 0;

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">{def.label}</h1>
        {form && (
          <button className="erp-btn erp-btn--primary" onClick={() => { setEditRow(null); setShowForm(true); }}>
            + New
          </button>
        )}
      </div>

      {showForm && form && (
        <ResourceForm
          title={def.label}
          mode="create"
          fields={form}
          doc={doc}
          onSubmit={submitCreate}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); refresh(); }}
        />
      )}

      {editRow && form && (
        <ResourceForm
          title={def.label}
          mode="edit"
          fields={form}
          doc={doc}
          initialValues={rowToValues(editRow, form)}
          initialLines={doc ? rowToLines(editRow, doc) : undefined}
          onSubmit={submitEdit(editRow)}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); refresh(); }}
        />
      )}

      <RowActionModals
        action={modalAction}
        onClose={() => setModalAction(null)}
        onSaved={() => { setModalAction(null); refresh(); }}
      />

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403
            ? 'You do not have permission to view this (RBAC). Try a role that owns this module.'
            : `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`}
        </div>
      )}
      {actionError && (
        <div className="erp-alert erp-alert--error" role="alert">{actionError}</div>
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
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={c.kind === 'num' ? 'cell-num' : undefined}>{c.label}</th>
                ))}
                {showActions && <th style={{ width: rowActions.length ? 240 : 140 }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={(columns.length || 1) + (showActions ? 1 : 0)} className="muted" style={{ padding: 16 }}>No records.</td></tr>
              )}
              {rows.map((row, i) => {
                const id = idOf(row, def);
                const rowBusy = busyId != null && busyId === id;
                return (
                  <tr key={i}>
                    {columns.map((c) => {
                      const v = row[c.key];
                      if (c.kind === 'status' && v != null) {
                        return <td key={c.key}><span className={`erp-badge erp-badge--${badgeClass(String(v))}`}>{String(v)}</span></td>;
                      }
                      const cls = c.kind === 'num' ? 'cell-num' : c.kind === 'mono' ? 'cell-mono' : undefined;
                      return <td key={c.key} className={cls}>{v == null ? '' : String(v)}</td>;
                    })}
                    {showActions && (
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {rowActions.map((a) => (
                            <button key={a.kind} type="button" className="erp-btn erp-btn--sm erp-btn--primary"
                              disabled={rowBusy}
                              onClick={() => clickAction(row, a)}>{rowBusy ? '…' : a.label}</button>
                          ))}
                          {form && (
                            <>
                              <button type="button" className="erp-btn erp-btn--sm"
                                disabled={rowBusy}
                                onClick={() => openEdit(row)}>Edit</button>
                              <button type="button" className="erp-btn erp-btn--sm erp-btn--danger"
                                disabled={rowBusy}
                                onClick={() => handleDelete(row)}>{rowBusy ? '…' : 'Delete'}</button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
