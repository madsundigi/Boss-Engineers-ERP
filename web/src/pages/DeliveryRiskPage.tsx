import { useState, FormEvent } from 'react';
import { api, ApiError } from '../api/client';

interface RiskSignals {
  overduePurchaseOrders: number;
  delayedWorkOrders: number;
  pendingOrFailedFats: number;
}
interface DeliveryRisk {
  projectId: number;
  riskLevel: 'GREEN' | 'YELLOW' | 'RED';
  driver: string;
  signals: RiskSignals;
  asOf: string;
}

const RISK_COLORS: Record<DeliveryRisk['riskLevel'], string> = {
  GREEN: '#16a34a',
  YELLOW: '#d97706',
  RED: '#dc2626',
};

/**
 * Delivery Risk (per project). Takes a Project ID and calls
 * GET /api/delivery-forecasts/risk/{projectId}, then surfaces a RAG risk badge,
 * the driving reason, and the underlying delay signals.
 */
export function DeliveryRiskPage() {
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<DeliveryRisk | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const id = projectId.trim();
    if (!id) return;
    setLoading(true);
    setError(null);
    setData(null);
    api.get<DeliveryRisk>(`/api/delivery-forecasts/risk/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e: ApiError) => setError(e))
      .finally(() => setLoading(false));
  }

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Delivery Risk</h1>
      </div>

      <form onSubmit={submit} style={{ display: 'flex', alignItems: 'flex-end', gap: 12, maxWidth: 420 }}>
        <div className="erp-field" style={{ flex: 1 }}>
          <label className="erp-label" htmlFor="delivery-risk-project">Project ID</label>
          <input
            id="delivery-risk-project"
            className="erp-input"
            type="number"
            min="1"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="e.g. 1024"
          />
        </div>
        <button type="submit" className="erp-btn erp-btn--primary" disabled={loading || !projectId.trim()}>
          Check
        </button>
      </form>

      {error && (
        <div className="erp-alert erp-alert--error" role="alert">
          {error.status === 403
            ? 'Your role lacks permission to view delivery risk.'
            : error.status === 404
              ? `No project found for ID ${projectId.trim()}.`
              : error.message}
        </div>
      )}

      {loading && <div className="spinner">Computing risk…</div>}

      {!loading && !data && !error && (
        <div className="muted">Enter a Project ID to compute its delivery risk.</div>
      )}

      {data && (
        <div className="erp-stack">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <span
              style={{
                background: RISK_COLORS[data.riskLevel],
                color: '#fff',
                fontWeight: 700,
                fontSize: 20,
                padding: '8px 20px',
                borderRadius: 999,
                letterSpacing: 0.5,
              }}
            >
              {data.riskLevel}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>{data.driver}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Project {data.projectId} · as of {new Date(data.asOf).toLocaleString('en-IN')}
              </div>
            </div>
          </div>

          <div className="erp-dash-grid">
            <div className="erp-kpi">
              <div className="erp-kpi__label">Overdue Purchase Orders</div>
              <div className="erp-kpi__value num">{data.signals.overduePurchaseOrders.toLocaleString('en-IN')}</div>
            </div>
            <div className="erp-kpi">
              <div className="erp-kpi__label">Delayed Work Orders</div>
              <div className="erp-kpi__value num">{data.signals.delayedWorkOrders.toLocaleString('en-IN')}</div>
            </div>
            <div className="erp-kpi">
              <div className="erp-kpi__label">Pending / Failed FATs</div>
              <div className="erp-kpi__value num">{data.signals.pendingOrFailedFats.toLocaleString('en-IN')}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
