import { useState, useEffect } from 'react';
import { api, ApiError } from '../api/client';

interface ServiceKpis {
  mttrHours: number;
  slaCompliancePct: number;
  csatAvg: number;
  csatCount: number;
  firstTimeFixPct: number;
  resolvedCount: number;
  openCount: number;
  totalTickets: number;
}

const inr = (v: number) => v.toLocaleString('en-IN');

/**
 * Service KPIs dashboard. Calls GET /api/service-tickets/kpis and renders the
 * after-sales service health metrics (MTTR, SLA, CSAT, first-time-fix, volumes)
 * as a tile grid.
 */
export function ServiceKpisPage() {
  const [data, setData] = useState<ServiceKpis | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.get<ServiceKpis>('/api/service-tickets/kpis')
      .then(setData)
      .catch((e: ApiError) => setError(e));
  }, []);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Service KPIs</h1>
      </div>

      {error && (
        <div className="erp-alert erp-alert--error" role="alert">
          {error.status === 403 ? 'Your role lacks permission to view service KPIs.' : error.message}
        </div>
      )}

      {!data && !error && <div className="spinner">Loading KPIs…</div>}

      {data && (
        <div className="erp-dash-grid">
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">MTTR (hours)</div>
            <div className="erp-kpi__value num">{data.mttrHours.toFixed(1)}</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">SLA Compliance</div>
            <div className="erp-kpi__value num">{data.slaCompliancePct.toFixed(1)}%</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">CSAT (avg / 5)</div>
            <div className="erp-kpi__value num">{data.csatAvg.toFixed(1)}</div>
            <div className="erp-kpi__delta muted">{inr(data.csatCount)} ratings</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">First-Time-Fix</div>
            <div className="erp-kpi__value num">{data.firstTimeFixPct.toFixed(1)}%</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">Resolved</div>
            <div className="erp-kpi__value num">{inr(data.resolvedCount)}</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">Open</div>
            <div className="erp-kpi__value num">{inr(data.openCount)}</div>
          </div>
          <div className="erp-kpi erp-kpi--accent">
            <div className="erp-kpi__label">Total Tickets</div>
            <div className="erp-kpi__value num">{inr(data.totalTickets)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
