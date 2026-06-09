import { useState, useEffect } from 'react';
import { api, ApiError } from '../api/client';

interface StageRow { stage: string; count: number; gross: number; weighted: number }
interface MonthRow { month: string; count: number; gross: number; weighted: number }
interface Forecast {
  weightedTotal: number;
  grossOpenTotal: number;
  wonTotal: number;
  byStage: StageRow[];
  byMonth: MonthRow[];
}

const money = (v: number) => '₹' + v.toLocaleString('en-IN');
const num = (v: number) => v.toLocaleString('en-IN');

/**
 * Revenue Forecast. Calls GET /api/crm/opportunities/forecast and shows the
 * probability-weighted pipeline alongside breakdowns by sales stage and by
 * expected-close month.
 */
export function RevenueForecastPage() {
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.get<Forecast>('/api/crm/opportunities/forecast')
      .then(setData)
      .catch((e: ApiError) => setError(e));
  }, []);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Revenue Forecast</h1>
      </div>

      {error && (
        <div className="erp-alert erp-alert--error" role="alert">
          {error.status === 403 ? 'Your role lacks permission to view the revenue forecast.' : error.message}
        </div>
      )}

      {!data && !error && <div className="spinner">Loading forecast…</div>}

      {data && (
        <>
          <div className="erp-dash-grid">
            <div className="erp-kpi erp-kpi--accent">
              <div className="erp-kpi__label">Weighted Pipeline</div>
              <div className="erp-kpi__value num">{money(data.weightedTotal)}</div>
            </div>
            <div className="erp-kpi erp-kpi--accent">
              <div className="erp-kpi__label">Gross Open</div>
              <div className="erp-kpi__value num">{money(data.grossOpenTotal)}</div>
            </div>
            <div className="erp-kpi erp-kpi--accent">
              <div className="erp-kpi__label">Won</div>
              <div className="erp-kpi__value num">{money(data.wonTotal)}</div>
            </div>
          </div>

          <div className="erp-panel">
            <div className="erp-panel__head">By Stage</div>
            <div className="erp-panel__body" style={{ padding: 0 }}>
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th className="col-num">Count</th>
                    <th className="col-num">Gross</th>
                    <th className="col-num">Weighted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byStage.map((r) => (
                    <tr key={r.stage}>
                      <td>{r.stage}</td>
                      <td className="col-num">{num(r.count)}</td>
                      <td className="col-num">{money(r.gross)}</td>
                      <td className="col-num">{money(r.weighted)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="erp-panel">
            <div className="erp-panel__head">By Month</div>
            <div className="erp-panel__body" style={{ padding: 0 }}>
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="col-num">Count</th>
                    <th className="col-num">Gross</th>
                    <th className="col-num">Weighted</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byMonth.map((r) => (
                    <tr key={r.month}>
                      <td>{r.month}</td>
                      <td className="col-num">{num(r.count)}</td>
                      <td className="col-num">{money(r.gross)}</td>
                      <td className="col-num">{money(r.weighted)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
