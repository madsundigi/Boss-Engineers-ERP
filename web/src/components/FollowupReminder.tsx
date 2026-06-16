import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Followup } from './FollowupPanel';
import { Icon } from './Icon';

/* =====================================================================
   Same-day follow-up reminder. Mounted once in the authed shell, it polls
   the follow-up dashboard on login and every hour; when a follow-up is DUE
   today it pops a window + plays a gentle audio chime. The user can:
     • Skip            — dismiss; reappears at the next hourly check (~1h)
     • Remind me later — snooze a chosen interval (15m / 30m / 1h / 2h)
     • Remind tomorrow — snooze until tomorrow morning
     • Postpone to …   — reschedule that follow-up to a specific date (PATCH)
     • Mark done       — complete that follow-up
   Snooze state lives in localStorage so it survives reloads.
   ===================================================================== */

const SNOOZE_KEY = 'fu_reminder_snooze_until';
const HOUR = 3_600_000;

function snoozedUntil(): number { return Number(localStorage.getItem(SNOOZE_KEY) || 0); }
function setSnoozeFor(ms: number) { localStorage.setItem(SNOOZE_KEY, String(Date.now() + ms)); }

/** YYYY-MM-DD for today, used as the date-input minimum + a "next day" default. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A gentle two-note chime via the Web Audio API (no asset needed). Best-effort:
 *  silently no-ops if the browser blocks audio (the popup still shows). */
function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    ([[880, 0], [1174.66, 0.18]] as [number, number][]).forEach(([freq, t]) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      const s = now + t;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.22, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.42);
      o.start(s); o.stop(s + 0.45);
    });
    setTimeout(() => { ctx.close().catch(() => undefined); }, 1300);
  } catch { /* audio blocked (no user gesture yet) — popup still shows */ }
}

export function FollowupReminder() {
  const [due, setDue] = useState<Followup[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [dates, setDates] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const openRef = useRef(false);
  const laterTimer = useRef<number | undefined>(undefined);

  openRef.current = !!(due && due.length);

  const check = useCallback(async () => {
    if (openRef.current) return;               // already showing — don't re-chime
    if (Date.now() < snoozedUntil()) return;   // snoozed
    try {
      const d = await api.get<{ rows: Followup[] }>('/api/followups/dashboard');
      const dueRows = (d.rows || []).filter((r) => r.urgency === 'DUE');
      if (dueRows.length) { setErr(null); setDue(dueRows); chime(); }
    } catch { /* 403 / offline — stay quiet */ }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(check, 1500);          // initial check shortly after login
    const id = window.setInterval(check, HOUR);         // hourly thereafter
    return () => { window.clearTimeout(t); window.clearInterval(id); window.clearTimeout(laterTimer.current); };
  }, [check]);

  function close() { setDue(null); setErr(null); }

  function snooze(ms: number) {
    setSnoozeFor(ms);
    close();
    window.clearTimeout(laterTimer.current);
    laterTimer.current = window.setTimeout(check, ms + 500);  // re-check when the snooze elapses
  }

  function snoozeTomorrow() {
    const now = new Date();
    const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
    snooze(Math.max(t.getTime() - now.getTime(), 60_000));
  }

  function dropRow(id: number) {
    setDue((cur) => { const next = (cur || []).filter((x) => x.followupId !== id); return next.length ? next : null; });
  }

  async function patch(f: Followup, body: Record<string, unknown>, label: string) {
    setBusyId(f.followupId); setErr(null);
    try {
      await api.patch(`/api/followups/${f.followupId}`, { ...body, rowVersion: f.rowVersion });
      dropRow(f.followupId);
    } catch (e) {
      const a = e as ApiError;
      setErr(a.status === 409 ? `Couldn't ${label} — it changed elsewhere; reopen to retry.`
        : `Couldn't ${label}: ${a.message}`);
    } finally { setBusyId(null); }
  }

  if (!due || due.length === 0) return null;
  const today = isoDate(new Date());

  return (
    <>
      <div className="erp-backdrop" />
      <div className="erp-modal" role="dialog" aria-modal="true" aria-label="Follow-up reminder">
        <div className="erp-modal__dialog erp-modal__dialog--lg">
          <div className="erp-modal__head">
            <span className="erp-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--c-warning)' }}><Icon name="bell" size={18} /></span>
              Follow-up reminder — {due.length} due today
            </span>
            <button className="erp-modal__close" onClick={() => snooze(HOUR)} title="Skip (remind in 1 hour)">×</button>
          </div>

          <div className="erp-modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {err && <div className="erp-alert erp-alert--error" role="alert">{err}</div>}
            {due.map((f) => {
              const channel = f.channel === 'OTHER' ? (f.channelOther || 'Other') : f.channel;
              const how = f.followupType === 'PHYSICAL' ? `Meet at ${f.location || '—'}` : `${channel || '—'} (virtual)`;
              const busy = busyId === f.followupId;
              return (
                <div key={f.followupId} className="erp-card" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
                  <div style={{ fontWeight: 600 }}>
                    <span className="cell-mono">{f.enquiryNo}</span> · {f.customerName}
                  </div>
                  <div className="muted" style={{ fontSize: 'var(--fs-12)', marginBottom: 8 }}>{how} · due {f.scheduledDate}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="erp-field" style={{ gap: 4 }}>
                      <label className="erp-label">Postpone to</label>
                      <input type="date" className="erp-input" min={today} style={{ width: 160 }}
                        value={dates[f.followupId] || ''}
                        onChange={(e) => setDates((d) => ({ ...d, [f.followupId]: e.target.value }))} />
                    </div>
                    <button className="erp-btn erp-btn--primary erp-btn--sm" disabled={busy || !dates[f.followupId]}
                      onClick={() => patch(f, { scheduledDate: dates[f.followupId] }, 'postpone')}>Postpone</button>
                    <button className="erp-btn erp-btn--sm" disabled={busy}
                      onClick={() => patch(f, { status: 'DONE' }, 'mark done')}>{busy ? '…' : 'Mark done'}</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="erp-modal__foot" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div className="erp-row">
              <span className="muted" style={{ fontSize: 'var(--fs-12)' }}>Remind me later:</span>
              <select className="erp-select" style={{ width: 'auto' }} defaultValue=""
                onChange={(e) => { if (e.target.value) snooze(Number(e.target.value)); }}>
                <option value="" disabled>choose…</option>
                <option value={900_000}>in 15 minutes</option>
                <option value={1_800_000}>in 30 minutes</option>
                <option value={3_600_000}>in 1 hour</option>
                <option value={7_200_000}>in 2 hours</option>
              </select>
            </div>
            <div className="erp-row">
              <button className="erp-btn erp-btn--sm" onClick={() => snooze(HOUR)}>Skip</button>
              <button className="erp-btn erp-btn--sm" onClick={snoozeTomorrow}>Remind me tomorrow</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
