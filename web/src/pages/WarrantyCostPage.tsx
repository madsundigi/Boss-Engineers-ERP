import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface Totals { tickets: number; inWarrantyTickets: number; travelCost: number; spareCost: number; claimCost: number; totalCost: number }
interface CustRow { customerId: number; customerName: string; tickets: number; totalCost: number }
interface MonthRow { month: string; tickets: number; totalCost: number }
interface Report { totals: Totals; byCustomer: CustRow[]; byMonth: MonthRow[] }

const rs = (v: number) => '₹' + (v ?? 0).toLocaleString('en-IN');

/** Warranty Cost Analysis — service spend (visits + spares + claims) by customer & month. */
export function WarrantyCostPage() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Report>('/api/service-tickets/warranty-cost')
      .then(setData).catch((e: ApiError) => setError(e)).finally(() => setLoading(false));
  }, []);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head"><h1 className="erp-page__title">Warranty Cost Analysis</h1></div>
      {error && <div className="erp-alert erp-alert--error" role="alert">
        {error.status === 403 ? 'Your role lacks permission to view service costs.' : error.message}</div>}
      {loading && <div className="spinner">Loading…</div>}
      {data && (
        <>
          <div className="erp-dash-grid">
            <Kpi label="Total Warranty Cost" value={rs(data.totals.totalCost)} accent />
            <Kpi label="Travel Cost" value={rs(data.totals.travelCost)} />
            <Kpi label="Spare Parts" value={rs(data.totals.spareCost)} />
            <Kpi label="Warranty Claims" value={rs(data.totals.claimCost)} />
            <Kpi label="Tickets" value={String(data.totals.tickets)} />
            <Kpi label="In-Warranty" value={String(data.totals.inWarrantyTickets)} />
          </div>

          <div className="erp-panel">
            <div className="erp-panel__head">Cost by Customer</div>
            <div className="erp-panel__body" style={{ padding: 0 }}>
              <table className="erp-table">
                <thead><tr><th>Customer</th><th>Tickets</th><th>Total Cost</th></tr></thead>
                <tbody>
                  {data.byCustomer.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>No warranty service recorded.</td></tr>}
                  {data.byCustomer.map((r) => (
                    <tr key={r.customerId}><td>{r.customerName}</td><td>{r.tickets}</td><td className="mono">{rs(r.totalCost)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="erp-panel">
            <div className="erp-panel__head">Cost by Month</div>
            <div className="erp-panel__body" style={{ padding: 0 }}>
              <table className="erp-table">
                <thead><tr><th>Month</th><th>Tickets</th><th>Total Cost</th></tr></thead>
                <tbody>
                  {data.byMonth.length === 0 && <tr><td colSpan={3} className="muted" style={{ padding: 12 }}>—</td></tr>}
                  {data.byMonth.map((r) => (
                    <tr key={r.month}><td className="mono">{r.month}</td><td>{r.tickets}</td><td className="mono">{rs(r.totalCost)}</td></tr>
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

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={'erp-kpi' + (accent ? ' erp-kpi--accent' : '')}>
      <div className="erp-kpi__label">{label}</div>
      <div className="erp-kpi__value num">{value}</div>
    </div>
  );
}
