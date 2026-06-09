import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

type Kpis = Record<string, unknown>;

const LABELS: Record<string, string> = {
  activeProjects: 'Active Projects',
  orderBook: 'Order Book',
  wipWorkOrders: 'WIP Work Orders',
  dispatchesMtd: 'Dispatches (MTD)',
  arOutstanding: 'AR Outstanding',
  apOutstanding: 'AP Outstanding',
  openNcrs: 'Open NCRs',
  avgMarginPct: 'Avg Margin %',
  deliveryAtRisk: 'Delivery At-Risk',
  criticalItems: 'Critical Items',
};

function fmt(key: string, v: unknown): string {
  if (typeof v !== 'number') return v == null ? '—' : String(v);
  if (/Outstanding|orderBook|Value/i.test(key)) return '₹' + v.toLocaleString('en-IN');
  if (/Pct/i.test(key)) return `${v.toFixed(1)}%`;
  return v.toLocaleString('en-IN');
}

export function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api.get<Kpis>('/api/dashboard/kpis')
      .then(setKpis)
      .catch((e: ApiError) => setError(e));
  }, []);

  const tiles = Object.entries(LABELS).filter(([k]) => kpis && k in kpis);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Executive Dashboard</h1>
      </div>

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403 ? 'Your role lacks DASHBOARD.VIEW.' : error.message}
        </div>
      )}

      {!kpis && !error && <div className="spinner">Loading KPIs…</div>}

      {kpis && (
        <div className="erp-dash-grid">
          {tiles.map(([key]) => (
            <div className="erp-kpi erp-kpi--accent" key={key}>
              <div className="erp-kpi__label">{LABELS[key]}</div>
              <div className="erp-kpi__value num">{fmt(key, kpis[key])}</div>
            </div>
          ))}
        </div>
      )}

      {kpis && 'salesPipeline' in kpis && (
        <div className="erp-panel" style={{ marginTop: 16 }}>
          <div className="erp-panel__head">Sales Pipeline</div>
          <div className="erp-panel__body">
            <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(kpis.salesPipeline, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
