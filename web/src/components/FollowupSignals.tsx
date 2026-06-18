import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Followup, signalClass, daysLabel } from './FollowupPanel';

interface DashboardResp {
  rows: Followup[];
  summary: { due: number; upcoming: number; missed: number };
}
type UrgencyFilter = 'DUE' | 'UPCOMING' | 'MISSED' | null;

const STATUS_BADGE: Record<string, string> = { PENDING: 'pending', DONE: 'approved', CANCELLED: 'rejected' };

/** "Virtual · WhatsApp" / "Physical · Pune office" */
function typeLabel(f: Followup): string {
  if (f.followupType === 'PHYSICAL') return f.location ? `Physical · ${f.location}` : 'Physical';
  const ch = f.channel === 'OTHER' ? (f.channelOther || 'Other') : (f.channel || '—');
  return `Virtual · ${ch}`;
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Dashboard follow-up board: 4 clickable KPI tiles (Due / Upcoming / Missed /
 * Total) that filter a clean table of every pending follow-up. Clicking a row
 * opens a detail popup with the full record + quick Postpone / Mark-done.
 */
export function FollowupSignals() {
  const [data, setData] = useState<DashboardResp | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<UrgencyFilter>(null);
  const [detail, setDetail] = useState<Followup | null>(null);

  const load = useCallback(() => {
    api.get<DashboardResp>('/api/followups/dashboard')
      .then((d) => { setData(d); setError(null); })
      .catch((e: ApiError) => setError(e));
  }, []);
  useEffect(() => { load(); }, [load]);

  const all = data?.rows ?? [];
  const rows = filter ? all.filter((r) => r.urgency === filter) : all;
  const toggle = (u: UrgencyFilter) => setFilter((f) => (f === u ? null : u));

  return (
    <div className="erp-panel" style={{ marginTop: 16 }}>
      <div className="erp-panel__head">
        <span>Follow-ups</span>
        {data && <span className="muted" style={{ fontSize: 'var(--fs-12)', fontWeight: 400 }}>{all.length} pending</span>}
      </div>
      <div className="erp-panel__body">
        {error && (
          <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
            {error.status === 403 ? 'Your role lacks access to follow-ups.' : error.message}
          </div>
        )}
        {!data && !error && <div className="spinner">Loading follow-ups…</div>}

        {data && (
          <>
            <div className="erp-fu-kpis">
              <KpiTile mod="due" label="Due today" value={data.summary.due} active={filter === 'DUE'} onClick={() => toggle('DUE')} />
              <KpiTile mod="upcoming" label="Upcoming" value={data.summary.upcoming} active={filter === 'UPCOMING'} onClick={() => toggle('UPCOMING')} />
              <KpiTile mod="missed" label="Missed" value={data.summary.missed} active={filter === 'MISSED'} onClick={() => toggle('MISSED')} />
              <KpiTile mod="total" label="All pending" value={all.length} active={filter === null} onClick={() => setFilter(null)} />
            </div>

            <div className="erp-table-wrap" style={{ border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)' }}>
              <table className="erp-table">
                <thead>
                  <tr><th>Enquiry</th><th>Customer</th><th>Type</th><th>Scheduled</th><th>Due</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={6} className="muted" style={{ padding: 16 }}>
                      No {filter ? `${filter.toLowerCase()} ` : ''}follow-ups — you're all caught up.
                    </td></tr>
                  ) : rows.map((f) => (
                    <tr key={f.followupId} className="is-clickable" onClick={() => setDetail(f)}
                      title="Click for details">
                      <td className="cell-mono">{f.enquiryNo}</td>
                      <td>{f.customerName}</td>
                      <td>{typeLabel(f)}</td>
                      <td className="cell-mono">{f.scheduledDate}</td>
                      <td><span className={signalClass(f.urgency)}>{daysLabel(f.daysRemaining)}</span></td>
                      <td><span className={`erp-badge erp-badge--${STATUS_BADGE[f.status] ?? 'draft'}`}>{f.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {detail && <FollowupDetail f={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); load(); }} />}
    </div>
  );
}

function KpiTile({ mod, label, value, active, onClick }:
  { mod: string; label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`erp-fu-kpi erp-fu-kpi--${mod}${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="erp-fu-kpi__value">{value}</span>
      <span className="erp-fu-kpi__label">{label}</span>
    </button>
  );
}

/** Detail popup for a single follow-up — full record + Postpone / Mark done. */
function FollowupDetail({ f, onClose, onChanged }:
  { f: Followup; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/followups/${f.followupId}`, { ...body, rowVersion: f.rowVersion });
      onChanged();
    } catch (e) {
      const a = e as ApiError;
      setErr(a.status === 409 ? `Couldn't ${label} — it changed elsewhere; reopen to retry.` : `Couldn't ${label}: ${a.message}`);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="erp-backdrop" onClick={onClose} />
      <div className="erp-modal" role="dialog" aria-modal="true" aria-label="Follow-up details">
        <div className="erp-modal__dialog">
          <div className="erp-modal__head">
            <span className="erp-modal__title">Follow-up #{f.seq} · <span className="cell-mono">{f.enquiryNo}</span></span>
            <button className="erp-modal__close" onClick={onClose}>×</button>
          </div>
          <div className="erp-modal__body">
            <div style={{ marginBottom: 14 }}>
              <span className={signalClass(f.urgency)}>{f.urgency} · {daysLabel(f.daysRemaining)}</span>
            </div>
            {err && <div className="erp-alert erp-alert--error" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
            <dl className="erp-deflist">
              <dt>Customer</dt><dd>{f.customerName}</dd>
              <dt>Type</dt><dd>{typeLabel(f)}</dd>
              <dt>Scheduled</dt><dd>{f.scheduledDate}</dd>
              <dt>Status</dt><dd>{f.status}</dd>
              <dt>Assigned to</dt><dd>{f.assignedToName || '—'}</dd>
              <dt>Notes</dt><dd>{f.notes || '—'}</dd>
              {f.outcome && (<><dt>Outcome</dt><dd>{f.outcome}</dd></>)}
              <dt>Created</dt><dd>{(f.createdAt || '').slice(0, 10)}</dd>
            </dl>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 18, flexWrap: 'wrap' }}>
              <div className="erp-field" style={{ gap: 4 }}>
                <label className="erp-label">Postpone to</label>
                <input type="date" className="erp-input" min={isoToday()} style={{ width: 160 }}
                  value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <button className="erp-btn erp-btn--primary erp-btn--sm" disabled={busy || !date}
                onClick={() => patch({ scheduledDate: date }, 'postpone')}>Postpone</button>
              <button className="erp-btn erp-btn--sm" disabled={busy}
                onClick={() => patch({ status: 'DONE' }, 'mark done')}>{busy ? '…' : 'Mark done'}</button>
            </div>
          </div>
          <div className="erp-modal__foot"><button className="erp-btn erp-btn--sm" onClick={onClose}>Close</button></div>
        </div>
      </div>
    </>
  );
}
