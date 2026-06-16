import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Followup, signalClass, daysLabel } from './FollowupPanel';

interface DashboardResp {
  rows: Followup[];
  summary: { due: number; upcoming: number; missed: number };
}

/**
 * "Follow-ups due" dashboard panel: a 3-chip roll-up (Due / Upcoming / Missed)
 * over a list of the caller's pending follow-ups, each line carrying a blinking
 * colored urgency signal. Render on the Executive Dashboard.
 */
export function FollowupSignals() {
  const [data, setData] = useState<DashboardResp | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    api.get<DashboardResp>('/api/followups/dashboard?mine=true')
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
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              <span className="erp-signal erp-signal--due">Due {data.summary.due}</span>
              <span className="erp-signal erp-signal--upcoming">Upcoming {data.summary.upcoming}</span>
              <span className="erp-signal erp-signal--missed">Missed {data.summary.missed}</span>
            </div>

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
