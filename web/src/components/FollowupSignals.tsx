import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Followup, signalClass, daysLabel } from './FollowupPanel';

interface DashboardResp {
  rows: Followup[];
  summary: { due: number; upcoming: number; missed: number };
}

/**
 * "Follow-ups due" dashboard panel: a 3-chip roll-up (Due / Upcoming / Missed)
 * over ALL pending company follow-ups, each line carrying a blinking colored
 * urgency signal + who it is assigned to. Render on the Executive Dashboard.
 */
export function FollowupSignals() {
  const [data, setData] = useState<DashboardResp | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    // Company-wide view (not ?mine=true) so the dashboard surfaces every team
    // member's due/upcoming/missed follow-ups, not only the signed-in user's.
    api.get<DashboardResp>('/api/followups/dashboard')
      .then((d) => { if (live) setData(d); })
      .catch((e: ApiError) => { if (live) setError(e); });
    return () => { live = false; };
  }, []);

  return (
    <div className="erp-panel" style={{ marginTop: 16 }}>
      <div className="erp-panel__head">Follow-ups due</div>
      <div className="erp-panel__body">
        {error && (
          <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
            {error.status === 403 ? 'Your role lacks access to follow-ups.' : error.message}
          </div>
        )}

        {!data && !error && <div className="spinner">Loading follow-ups…</div>}

        {data && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span className="erp-signal erp-signal--due">Due {data.summary.due}</span>
              <span className="erp-signal erp-signal--upcoming">Upcoming {data.summary.upcoming}</span>
              <span className="erp-signal erp-signal--missed">Missed {data.summary.missed}</span>
            </div>

            <SignalBar
              due={data.summary.due}
              upcoming={data.summary.upcoming}
              missed={data.summary.missed} />

            {data.rows.length === 0 ? (
              <div className="muted">No pending follow-ups. You are all caught up.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.rows.map((f) => (
                  <div key={f.followupId}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
                    <span className={signalClass(f.urgency)} title={f.urgency} style={{ minWidth: 78, textAlign: 'center' }}>
                      {daysLabel(f.daysRemaining)}
                    </span>
                    <span style={{ flex: 1 }}>
                      <span className="cell-mono" style={{ fontWeight: 600 }}>{f.enquiryNo}</span>
                      <span className="muted"> · {f.customerName}</span>
                      <span> — {f.followupType.toLowerCase()}</span>
                      {f.assignedToName && <span className="muted"> · {f.assignedToName}</span>}
                    </span>
                    <span className="cell-mono muted">{f.scheduledDate}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A thin proportional segment bar summarising the follow-up mix (Due / Upcoming /
 * Missed). Colors mirror the urgency signals. Renders nothing extra when there is
 * no pending work — the "all caught up" line below already covers that case.
 */
function SignalBar({ due, upcoming, missed }: { due: number; upcoming: number; missed: number }) {
  const total = due + upcoming + missed;
  if (total === 0) return null;
  const segs = [
    { key: 'missed', value: missed, color: '#f43f5e' },
    { key: 'due', value: due, color: '#f59e0b' },
    { key: 'upcoming', value: upcoming, color: '#06b6d4' },
  ].filter((s) => s.value > 0);
  return (
    <div style={{
      display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden',
      background: 'var(--c-border, #e5e9f0)', marginBottom: 14,
    }} role="img" aria-label={`Follow-ups: ${due} due, ${upcoming} upcoming, ${missed} missed`}>
      {segs.map((s) => (
        <span key={s.key} title={`${s.key}: ${s.value}`}
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}
