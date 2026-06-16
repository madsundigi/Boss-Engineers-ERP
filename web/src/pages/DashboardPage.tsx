import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, type TooltipContentProps,
} from 'recharts';
import { api, ApiError } from '../api/client';
import { FollowupSignals } from '../components/FollowupSignals';
import { Icon, iconForPath } from '../components/Icon';
import { RESOURCES } from '../app/registry';

// ---- API shapes -----------------------------------------------------------
type Kpis = Record<string, unknown>;

interface FunnelRow { stage: string; count: number }
interface TrendRow { month: string; label: string; enquiries: number; quotations: number; revenue: number }

// ---- Theme ----------------------------------------------------------------
// Categorical palette (matches the design system); grid + axis tints are kept
// subtle so the charts read as clean executive visuals.
const PALETTE = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#0ea5e9', '#ec4899'];
const GRID = '#eef2f6';
const AXIS = '#94a3b8';

// KPI presentation: the icon name + color variant + (optional) accent bar, keyed
// by the KPI field. Order here is the display order of the strip.
type KpiColor = 'indigo' | 'emerald' | 'amber' | 'rose' | 'cyan' | 'violet';
const KPI_META: Record<string, { label: string; icon: Parameters<typeof Icon>[0]['name']; color: KpiColor }> = {
  revenue: { label: 'Revenue', icon: 'dollar', color: 'emerald' },
  orderBook: { label: 'Order Book', icon: 'briefcase', color: 'indigo' },
  activeProjects: { label: 'Active Projects', icon: 'folder', color: 'indigo' },
  wipWorkOrders: { label: 'WIP Work Orders', icon: 'factory', color: 'violet' },
  dispatchesMtd: { label: 'Dispatches (MTD)', icon: 'truck', color: 'cyan' },
  arOutstanding: { label: 'AR Outstanding', icon: 'receipt', color: 'amber' },
  apOutstanding: { label: 'AP Outstanding', icon: 'receipt', color: 'rose' },
  avgMarginPct: { label: 'Avg Margin %', icon: 'percent', color: 'emerald' },
  productionEfficiency: { label: 'Production Efficiency', icon: 'activity', color: 'cyan' },
  fatPassRate: { label: 'FAT Pass Rate', icon: 'check', color: 'emerald' },
  deliveryAtRisk: { label: 'Delivery At-Risk', icon: 'alert', color: 'amber' },
  openNcrs: { label: 'Open NCRs', icon: 'alert', color: 'rose' },
  criticalItems: { label: 'Critical Items', icon: 'alert', color: 'rose' },
  openServiceTickets: { label: 'Open Service Tickets', icon: 'wrench', color: 'violet' },
};
const KPI_ORDER = Object.keys(KPI_META);

// ---- formatting -----------------------------------------------------------
function fmtKpi(key: string, v: unknown): string {
  if (typeof v !== 'number') return v == null ? '—' : String(v);
  if (/Outstanding|orderBook|Value|revenue/i.test(key)) return inr(v);
  if (/Pct|Rate|Efficiency/i.test(key)) return `${v.toFixed(1)}%`;
  return v.toLocaleString('en-IN');
}
function inr(v: number): string {
  return '₹' + Math.round(v).toLocaleString('en-IN');
}
/** Compact ₹ for axis ticks: 1.2L / 3.4Cr / 9.5k. */
function inrCompact(v: number): string {
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return '₹' + v;
}

// ---- shared bits ----------------------------------------------------------
function useNarrow(maxWidth = 900): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < maxWidth : false);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < maxWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [maxWidth]);
  return narrow;
}

function Panel({ title, action, children, style }:
  { title: string; action?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="erp-panel" style={style}>
      <div className="erp-panel__head">
        <span>{title}</span>
        {action}
      </div>
      <div className="erp-panel__body">{children}</div>
    </div>
  );
}

function EmptyState({ message = 'No data yet' }: { message?: string }) {
  return (
    <div className="muted" style={{
      display: 'grid', placeItems: 'center', minHeight: 220, textAlign: 'center',
    }}>
      {message}
    </div>
  );
}

// A compact custom tooltip so currency series read as ₹ and counts read plainly.
// Typed with the recharts default generics so it slots straight into Tooltip.content.
function ChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{
      background: '#0f172a', color: '#f8fafc', borderRadius: 8, padding: '8px 10px',
      fontSize: 12, boxShadow: '0 8px 24px rgba(15,23,42,0.28)', lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 2, background: (p.color as string) || '#64748b',
            display: 'inline-block',
          }} />
          <span style={{ opacity: 0.85 }}>{p.name}</span>
          <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
            {p.dataKey === 'revenue'
              ? inr(Number(p.value))
              : Number(p.value).toLocaleString('en-IN')}
          </span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="erp-chart-legend">
      {items.map((it) => (
        <span className="erp-chart-legend__item" key={it.label}>
          <span className="erp-chart-legend__dot" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ===========================================================================
export function DashboardPage() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [funnel, setFunnel] = useState<FunnelRow[] | null>(null);
  const [trends, setTrends] = useState<TrendRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const narrow = useNarrow();

  useEffect(() => {
    let live = true;
    // KPIs drive the headline error/403 banner; the funnel + trends are best-effort
    // (a panel-local empty state covers a failed/empty secondary fetch).
    api.get<Kpis>('/api/dashboard/kpis')
      .then((d) => { if (live) setKpis(d); })
      .catch((e: ApiError) => { if (live) setError(e); });
    api.get<FunnelRow[]>('/api/dashboard/sales-funnel')
      .then((d) => { if (live) setFunnel(d); })
      .catch(() => { if (live) setFunnel([]); });
    api.get<{ rows: TrendRow[] }>('/api/dashboard/trends')
      .then((d) => { if (live) setTrends(d.rows ?? []); })
      .catch(() => { if (live) setTrends([]); });
    return () => { live = false; };
  }, []);

  const kpiTiles = KPI_ORDER.filter((k) => kpis && k in kpis);

  // Trend: render only if at least one series has a non-zero value.
  const trendHasData = !!trends && trends.some((r) => r.enquiries || r.quotations);
  const revenueHasData = !!trends && trends.some((r) => r.revenue);

  // Funnel donut data (drop all-zero so the chart isn't an empty ring).
  const funnelData = (funnel ?? [])
    .map((r, i) => ({ name: stageLabel(r.stage), value: r.count, color: PALETTE[i % PALETTE.length] }));
  const funnelTotal = funnelData.reduce((s, d) => s + d.value, 0);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Executive Dashboard</h1>
        <p className="erp-page__subtitle muted">
          Company-wide performance across sales, projects, production and finance.
        </p>
      </div>

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403 ? 'Your role lacks DASHBOARD.VIEW.' : error.message}
        </div>
      )}

      {!kpis && !error && <div className="spinner">Loading KPIs…</div>}

      {/* 2. KPI strip */}
      {kpis && (
        <div className="erp-dash-grid">
          {kpiTiles.map((key) => {
            const m = KPI_META[key];
            return (
              <div className="erp-kpi erp-kpi--accent" key={key}>
                <div className="erp-kpi__top">
                  <span className="erp-kpi__label">{m.label}</span>
                  <span className={`erp-kpi__icon erp-kpi__icon--${m.color}`}>
                    <Icon name={m.icon} size={18} />
                  </span>
                </div>
                <div className="erp-kpi__value num">{fmtKpi(key, kpis[key])}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 3. Two-column: trend (left) + pipeline donut (right) */}
      {kpis && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: narrow ? '1fr' : '1.6fr 1fr',
          gap: 16,
        }}>
          <Panel title="Sales & Demand Trend"
            action={<span className="muted" style={{ fontSize: 12 }}>last 6 months</span>}>
            {!trends ? (
              <div className="spinner">Loading trend…</div>
            ) : !trendHasData ? (
              <EmptyState message="No enquiries or quotations in the last 6 months" />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={trends} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gEnq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gQuo" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={PALETTE[1]} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={PALETTE[1]} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={{ stroke: GRID }} />
                    <YAxis allowDecimals={false} tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={false} width={32} />
                    <Tooltip content={ChartTooltip} cursor={{ stroke: GRID }} />
                    <Area type="monotone" dataKey="enquiries" name="Enquiries" stroke={PALETTE[0]}
                      strokeWidth={2.5} fill="url(#gEnq)" dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="quotations" name="Quotations" stroke={PALETTE[1]}
                      strokeWidth={2.5} fill="url(#gQuo)" dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
                <Legend items={[
                  { label: 'Enquiries', color: PALETTE[0] },
                  { label: 'Quotations', color: PALETTE[1] },
                ]} />
              </>
            )}
          </Panel>

          <Panel title="Sales Pipeline">
            {!funnel ? (
              <div className="spinner">Loading pipeline…</div>
            ) : funnelTotal === 0 ? (
              <EmptyState message="No pipeline activity yet" />
            ) : (
              <>
                <div style={{ position: 'relative' }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie data={funnelData} dataKey="value" nameKey="name"
                        innerRadius={64} outerRadius={96} paddingAngle={2} stroke="none">
                        {funnelData.map((d) => <Cell key={d.name} fill={d.color} />)}
                      </Pie>
                      <Tooltip content={ChartTooltip} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{
                    position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                    pointerEvents: 'none',
                  }}>
                    <div style={{ textAlign: 'center' }}>
                      <div className="num" style={{ fontSize: 28, fontWeight: 700, lineHeight: 1 }}>
                        {funnelTotal.toLocaleString('en-IN')}
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>total records</div>
                    </div>
                  </div>
                </div>
                <Legend items={funnelData.map((d) => ({ label: `${d.name} (${d.value})`, color: d.color }))} />
              </>
            )}
          </Panel>
        </div>
      )}

      {/* 4. Bar row: monthly revenue */}
      {kpis && (
        <Panel title="Monthly Revenue (₹)"
          action={<span className="muted" style={{ fontSize: 12 }}>invoiced, last 6 months</span>}>
          {!trends ? (
            <div className="spinner">Loading revenue…</div>
          ) : !revenueHasData ? (
            <EmptyState message="No invoiced revenue in the last 6 months" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={trends} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0.55} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={{ stroke: GRID }} />
                <YAxis tickFormatter={inrCompact} tick={{ fill: AXIS, fontSize: 12 }} tickLine={false} axisLine={false} width={52} />
                <Tooltip content={ChartTooltip} cursor={{ fill: 'rgba(79,70,229,0.06)' }} />
                <Bar dataKey="revenue" name="Revenue" fill="url(#gRev)" radius={[6, 6, 0, 0]} maxBarSize={56} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
      )}

      {/* 5. Follow-ups (own styled component) */}
      <FollowupSignals />

      {/* 6. Quick access to every module */}
      <Panel title="Modules">
        <div className="erp-module-grid">
          {RESOURCES.map((r) => (
            <Link className="erp-module-tile" to={`/r/${r.path}`} key={r.path}>
              <span className="erp-module-tile__icon">
                <Icon name={iconForPath(r.path)} size={20} />
              </span>
              <span className="erp-module-tile__label">{r.label}</span>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}

// Friendly funnel stage labels (the API returns ENQUIRY | QUOTATION | WON | PROJECT).
function stageLabel(stage: string): string {
  const m: Record<string, string> = {
    ENQUIRY: 'Enquiries', QUOTATION: 'Quotations', WON: 'Won', PROJECT: 'Projects',
  };
  return m[stage] ?? stage.charAt(0) + stage.slice(1).toLowerCase();
}
