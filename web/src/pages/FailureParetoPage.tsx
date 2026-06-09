import { useState, useEffect } from 'react';
import { api, ApiError } from '../api/client';

interface ParetoRow {
  failureModeId: number;
  failureMode: string;
  count: number;
  pct: number;
  cumulativePct: number;
  isRepeat: boolean;
}
interface Pareto {
  by: string;
  total: number;
  rows: ParetoRow[];
}

/**
 * Failure Pareto. Calls GET /api/ncrs/pareto?by=mode and ranks failure modes by
 * occurrence (with cumulative % and a repeat-offender flag) so quality can focus
 * on the vital few.
 */
export function FailureParetoPage() {
  const [data, setData] = useState<Pareto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.get<Pareto>('/api/ncrs/pareto?by=mode')
      .then(setData)
      .catch((e: ApiError) => setError(e));
  }, []);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Failure Pareto</h1>
      </div>

      {error && (
        <div className="erp-alert erp-alert--error" role="alert">
          {error.status === 403 ? 'Your role lacks permission to view the failure Pareto.' : error.message}
        </div>
      )}

      {!data && !error && <div className="spinner">Loading Pareto…</div>}

      {data && (
        <div className="erp-panel">
          <div className="erp-panel__head">
            Failure Modes <span className="muted">total {data.total.toLocaleString('en-IN')}</span>
          </div>
          <div className="erp-panel__body" style={{ padding: 0 }}>
            {data.rows.length === 0 ? (
              <div className="muted" style={{ padding: 16 }}>No failures recorded.</div>
            ) : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Failure Mode</th>
                    <th className="col-num">Count</th>
                    <th className="col-num">%</th>
                    <th className="col-num">Cumulative %</th>
                    <th>Repeat</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.failureModeId}>
                      <td>{r.failureMode}</td>
                      <td className="col-num">{r.count.toLocaleString('en-IN')}</td>
                      <td className="col-num">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                          <span>{r.pct.toFixed(1)}%</span>
                          <div style={{ flex: 1, maxWidth: 80, background: 'var(--c-border, #e5e7eb)', borderRadius: 2 }}>
                            <div style={{ width: `${Math.min(r.pct, 100)}%`, background: 'var(--c-accent,#2563eb)', height: 8, borderRadius: 2 }} />
                          </div>
                        </div>
                      </td>
                      <td className="col-num">{r.cumulativePct.toFixed(1)}%</td>
                      <td>{r.isRepeat ? <span className="muted">⟳ repeat</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
