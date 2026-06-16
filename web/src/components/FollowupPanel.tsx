import { useEffect, useState, FormEvent, CSSProperties } from 'react';
import { api, ApiError } from '../api/client';

// ---- Shared types + helpers (re-used by FollowupSignals) ------------------
export type FollowupUrgency = 'DONE' | 'CANCELLED' | 'MISSED' | 'DUE' | 'UPCOMING' | 'NORMAL';
export type FollowupType = 'VIRTUAL' | 'PHYSICAL';
export type FollowupChannel = 'WHATSAPP' | 'EMAIL' | 'PHONE' | 'VIDEO' | 'OTHER';

export interface Followup {
  followupId: number;
  enquiryId: number;
  enquiryNo: string;
  customerName: string;
  seq: number;
  followupType: FollowupType;
  channel: FollowupChannel | null;
  channelOther: string | null;
  location: string | null;
  scheduledDate: string;
  notes: string | null;
  status: 'PENDING' | 'DONE' | 'CANCELLED';
  outcome: string | null;
  assignedTo: number | null;
  assignedToName: string | null;
  completedAt: string | null;
  completedBy: number | null;
  daysRemaining: number;
  urgency: FollowupUrgency;
  createdAt: string;
  rowVersion: number;
}

/** Map a row's urgency onto its colored (and possibly blinking) signal class. */
export function signalClass(urgency: string): string {
  return `erp-signal erp-signal--${(urgency || 'normal').toLowerCase()}`;
}

/** Human "in 2 days" / "today" / "3 days overdue" from daysRemaining. */
export function daysLabel(daysRemaining: number): string {
  if (daysRemaining === 0) return 'today';
  if (daysRemaining > 0) return `in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
  const overdue = -daysRemaining;
  return `${overdue} day${overdue === 1 ? '' : 's'} overdue`;
}

const FOLLOWUP_CHANNELS: FollowupChannel[] = ['WHATSAPP', 'EMAIL', 'PHONE', 'VIDEO', 'OTHER'];

// ---- Modal scaffolding (mirrors ResourceForm) -----------------------------
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center', zIndex: 1000,
};
const dialog: CSSProperties = {
  width: 720, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto',
  background: 'var(--c-surface, #fff)', border: '1px solid var(--c-border, #d8dce1)',
  borderRadius: 6, boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
};

interface Props {
  enquiryId: unknown;
  enquiryNo?: string | null;
  customerName?: string | null;
  onClose: () => void;
}

function describeError(err: ApiError, fallback?: string): string {
  if (err.status === 403) return 'You do not have permission to manage follow-ups.';
  if (err.status === 409) return fallback ?? 'This follow-up was changed by someone else — reload and try again.';
  return `${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`;
}

// ---------------------------------------------------------------------------
export function FollowupPanel({ enquiryId, enquiryNo, customerName, onClose }: Props) {
  const [rows, setRows] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  // add-form state
  const [followupType, setFollowupType] = useState<FollowupType>('VIRTUAL');
  const [channel, setChannel] = useState<FollowupChannel>('WHATSAPP');
  const [channelOther, setChannelOther] = useState('');
  const [location, setLocation] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sid = encodeURIComponent(String(enquiryId));

  useEffect(() => {
    let live = true;
    setLoading(true);
    setListError(null);
    api.get<{ rows: Followup[] }>(`/api/followups?enquiryId=${sid}`)
      .then((d) => { if (live) setRows(d.rows ?? []); })
      .catch((e: ApiError) => { if (live) setListError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sid, reload]);

  const refresh = () => setReload((n) => n + 1);
  const nextSeq = (rows.reduce((m, r) => Math.max(m, r.seq), 0) || 0) + 1;

  async function markDone(f: Followup) {
    setActionError(null);
    setBusyId(f.followupId);
    try {
      await api.patch(`/api/followups/${f.followupId}`, { status: 'DONE', rowVersion: f.rowVersion });
      refresh();
    } catch (err) {
      setActionError(describeError(err as ApiError));
    } finally {
      setBusyId(null);
    }
  }

  async function addFollowup(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!scheduledDate) { setFormError('Scheduled date is required.'); return; }
    if (followupType === 'VIRTUAL' && !channel) { setFormError('Pick a channel for a virtual follow-up.'); return; }
    if (followupType === 'VIRTUAL' && channel === 'OTHER' && !channelOther.trim()) {
      setFormError('Describe the channel ("Other").'); return;
    }
    if (followupType === 'PHYSICAL' && !location.trim()) { setFormError('Location is required for a physical follow-up.'); return; }

    const body: Record<string, unknown> = {
      enquiryId: Number(enquiryId),
      followupType,
      scheduledDate,
    };
    if (notes.trim()) body.notes = notes.trim();
    if (followupType === 'VIRTUAL') {
      body.channel = channel;
      if (channel === 'OTHER') body.channelOther = channelOther.trim();
    } else {
      body.location = location.trim();
    }

    setSaving(true);
    try {
      await api.post('/api/followups', body);
      // clear the form, keep the type selection
      setChannelOther(''); setLocation(''); setScheduledDate(''); setNotes('');
      refresh();
    } catch (err) {
      setFormError(describeError(err as ApiError));
    } finally {
      setSaving(false);
    }
  }

  function whereLabel(f: Followup): string {
    if (f.followupType === 'PHYSICAL') return f.location || '—';
    if (f.channel === 'OTHER') return f.channelOther ? `Other: ${f.channelOther}` : 'Other';
    return f.channel || '—';
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div className="erp-modal__dialog" style={dialog} role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}>
        <div className="erp-modal__head">
          <span className="erp-modal__title">
            Follow-ups{enquiryNo ? ` — ${enquiryNo}` : ''}{customerName ? ` (${customerName})` : ''}
          </span>
          <button type="button" className="erp-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="erp-modal__body">
          {listError && (
            <div className={`erp-alert ${listError.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
              {listError.status === 403
                ? 'You do not have permission to view follow-ups.'
                : `${listError.message}${listError.status ? ` (HTTP ${listError.status})` : ''}`}
            </div>
          )}
          {actionError && <div className="erp-alert erp-alert--error" role="alert">{actionError}</div>}

          {/* trail */}
          {loading ? (
            <div className="spinner">Loading follow-ups…</div>
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th>Type</th>
                  <th>Channel / Location</th>
                  <th>Scheduled</th>
                  <th>Urgency</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th style={{ width: 90 }} aria-label="actions"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="muted" style={{ padding: 12 }}>No follow-ups yet.</td></tr>
                )}
                {rows.map((f) => {
                  const rowBusy = busyId === f.followupId;
                  return (
                    <tr key={f.followupId}>
                      <td className="cell-mono">{f.seq}</td>
                      <td>{f.followupType}</td>
                      <td>{whereLabel(f)}</td>
                      <td className="cell-mono">{f.scheduledDate}</td>
                      <td><span className={signalClass(f.urgency)}>{f.urgency}</span></td>
                      <td>{f.status}</td>
                      <td>{f.notes || ''}</td>
                      <td>
                        {f.status === 'PENDING' && (
                          <button type="button" className="erp-btn erp-btn--sm erp-btn--primary"
                            disabled={rowBusy} onClick={() => markDone(f)}>
                            {rowBusy ? '…' : 'Mark done'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* add form */}
          <div style={{ marginTop: 18 }}>
            <div className="erp-table-toolbar" style={{ marginBottom: 8 }}>
              <strong>Add follow-up</strong>
              <span className="muted" style={{ marginLeft: 8 }}>#{nextSeq} (auto)</span>
            </div>
            {formError && <div className="erp-alert erp-alert--error" role="alert">{formError}</div>}
            <form onSubmit={addFollowup}>
              <div className="erp-form__grid">
                <div className="erp-field erp-field--12">
                  <label className="erp-label">Type</label>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" name="followupType" checked={followupType === 'VIRTUAL'}
                        onChange={() => setFollowupType('VIRTUAL')} /> Virtual
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="radio" name="followupType" checked={followupType === 'PHYSICAL'}
                        onChange={() => setFollowupType('PHYSICAL')} /> Physical
                    </label>
                  </div>
                </div>

                {followupType === 'VIRTUAL' ? (
                  <>
                    <div className="erp-field erp-field--6">
                      <label className="erp-label">Channel <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                      <select className="erp-select" value={channel}
                        onChange={(e) => setChannel(e.target.value as FollowupChannel)}>
                        {FOLLOWUP_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {channel === 'OTHER' && (
                      <div className="erp-field erp-field--6">
                        <label className="erp-label">Channel (Other) <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                        <input className="erp-input" value={channelOther}
                          onChange={(e) => setChannelOther(e.target.value)} placeholder="e.g. Telegram" />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="erp-field erp-field--6">
                    <label className="erp-label">Location <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                    <input className="erp-input" value={location}
                      onChange={(e) => setLocation(e.target.value)} placeholder="Site / office address" />
                  </div>
                )}

                <div className="erp-field erp-field--6">
                  <label className="erp-label">Scheduled Date <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                  <input className="erp-input" type="date" value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)} />
                </div>
                <div className="erp-field erp-field--12">
                  <label className="erp-label">Notes</label>
                  <textarea className="erp-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <button type="submit" className="erp-btn erp-btn--primary" disabled={saving}>
                  {saving ? 'Adding…' : 'Add follow-up'}
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="erp-modal__foot">
          <button type="button" className="erp-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
