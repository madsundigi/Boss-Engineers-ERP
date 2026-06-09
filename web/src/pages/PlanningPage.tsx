import { useState, useEffect, FormEvent, useCallback } from 'react';
import { api, ApiError } from '../api/client';

interface Task {
  taskId: number; taskName: string; plannedStart: string; plannedEnd: string;
  percentComplete: number; isCriticalPath: boolean; durationDays: number;
}
interface Milestone { milestoneId: number; name: string; plannedDate: string | null; status: string; isPaymentMilestone: boolean }
interface Project { projectId: number; projectNo: string; projectName: string }
interface Rows<T> { rows: T[] }

const DAY = 86_400_000;
const dayOf = (iso: string) => Math.floor(Date.parse(iso) / DAY);
const fmt = (iso: string) => new Date(Date.parse(iso)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

/**
 * Project Planning + Gantt chart (M4). Reads the planning API
 * (/api/planning/projects/:id/schedule + /milestones) and renders a date-scaled
 * timeline: one bar per task (filled by % complete, critical path in red),
 * milestone diamonds, and a "today" marker.
 */
export function PlanningPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | ''>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<'task' | 'milestone' | null>(null);

  useEffect(() => {
    api.get<Rows<Project>>('/api/projects?pageSize=100')
      .then((d) => { setProjects(d.rows ?? []); if ((d.rows ?? []).length && !projectId) setProjectId(d.rows[0].projectId); })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true); setError(null);
    Promise.all([
      api.get<Rows<Task>>(`/api/planning/projects/${projectId}/schedule`),
      api.get<Rows<Milestone>>(`/api/planning/projects/${projectId}/milestones`),
    ]).then(([s, m]) => { setTasks(s.rows ?? []); setMilestones(m.rows ?? []); })
      .catch((e: ApiError) => setError(e))
      .finally(() => setLoading(false));
  }, [projectId]);
  useEffect(load, [load]);

  // Date axis across all task spans + dated milestones.
  const dated = [
    ...tasks.flatMap((t) => [dayOf(t.plannedStart), dayOf(t.plannedEnd)]),
    ...milestones.filter((m) => m.plannedDate).map((m) => dayOf(m.plannedDate as string)),
  ];
  const minDay = dated.length ? Math.min(...dated) - 2 : 0;
  const maxDay = dated.length ? Math.max(...dated) + 2 : 1;
  const span = Math.max(1, maxDay - minDay);
  const pct = (d: number) => ((d - minDay) / span) * 100;
  const today = Math.floor(Date.now() / DAY);

  // Month gridlines/labels.
  const months: { label: string; left: number }[] = [];
  if (dated.length) {
    const d = new Date(minDay * DAY); d.setUTCDate(1);
    for (let i = 0; i < 60 && Math.floor(d.getTime() / DAY) <= maxDay; i++) {
      months.push({ label: d.toLocaleString('en', { month: 'short', year: '2-digit' }), left: pct(Math.floor(d.getTime() / DAY)) });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }

  return (
    <div className="erp-page erp-stack">
      <style>{`
        .gantt { border:1px solid var(--c-border,#dce1e7); border-radius:6px; overflow:hidden; background:#fff; }
        .gantt-row { display:flex; align-items:center; height:30px; border-top:1px solid #eef1f5; }
        .gantt-row:hover { background:#f8fafc; }
        .gantt-name { flex:0 0 230px; padding:0 10px; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .gantt-track { position:relative; flex:1; height:100%; }
        .gantt-bar { position:absolute; top:6px; height:18px; border-radius:4px; border:1px solid; overflow:hidden; min-width:3px; }
        .gantt-fill { position:absolute; left:0; top:0; bottom:0; opacity:.85; }
        .gantt-blabel { position:absolute; right:4px; top:1px; font-size:10px; color:#1a2230; z-index:1; }
        .gantt-axis { position:relative; flex:1; height:22px; }
        .gantt-month { position:absolute; top:3px; font-size:10px; color:#5a6675; border-left:1px solid #e2e8f0; padding-left:4px; height:16px; }
        .gantt-today { position:absolute; top:0; bottom:0; width:2px; background:#dc2626; z-index:2; }
        .gantt-ms { position:absolute; top:3px; transform:translateX(-50%); font-size:13px; }
      `}</style>

      <div className="erp-page__head" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 className="erp-page__title">Project Planning &amp; Gantt</h1>
        <select className="erp-select" style={{ maxWidth: 320, marginLeft: 'auto' }}
          value={projectId} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Select a project…</option>
          {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.projectNo} — {p.projectName}</option>)}
        </select>
      </div>

      {error && <div className="erp-alert erp-alert--error" role="alert">{error.message}</div>}
      {loading && <div className="spinner">Loading schedule…</div>}
      {!projectId && <div className="muted">Pick a project to see its schedule.</div>}

      {projectId && !loading && (
        <>
          <div className="erp-table-toolbar" style={{ display: 'flex', gap: 8 }}>
            <strong>{tasks.length} tasks · {milestones.length} milestones</strong>
            <button type="button" className="erp-btn erp-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setForm('task')}>+ Task</button>
            <button type="button" className="erp-btn erp-btn--sm" onClick={() => setForm('milestone')}>+ Milestone</button>
          </div>

          {tasks.length === 0 && milestones.length === 0 ? (
            <div className="muted">No tasks yet — add the first one to build the schedule.</div>
          ) : (
            <div className="gantt">
              {/* axis */}
              <div className="gantt-row" style={{ height: 22, borderTop: 'none', background: '#f1f5f9' }}>
                <div className="gantt-name" style={{ fontWeight: 600 }}>Task</div>
                <div className="gantt-axis">
                  {months.map((m, i) => <span key={i} className="gantt-month" style={{ left: `${m.left}%` }}>{m.label}</span>)}
                  {today >= minDay && today <= maxDay && <div className="gantt-today" style={{ left: `${pct(today)}%` }} title="Today" />}
                </div>
              </div>
              {/* task bars */}
              {tasks.map((t) => {
                const left = pct(dayOf(t.plannedStart));
                const width = Math.max(0.6, pct(dayOf(t.plannedEnd)) - left);
                const red = t.isCriticalPath;
                return (
                  <div className="gantt-row" key={t.taskId} title={`${t.taskName}  ${fmt(t.plannedStart)} → ${fmt(t.plannedEnd)}  (${t.percentComplete}%)`}>
                    <div className="gantt-name">{red && <span style={{ color: '#dc2626' }}>● </span>}{t.taskName}</div>
                    <div className="gantt-track">
                      {today >= minDay && today <= maxDay && <div className="gantt-today" style={{ left: `${pct(today)}%`, opacity: .25 }} />}
                      <div className="gantt-bar" style={{ left: `${left}%`, width: `${width}%`, background: red ? '#fde2e1' : '#e0ecff', borderColor: red ? '#dc2626' : '#2563eb' }}>
                        <div className="gantt-fill" style={{ width: `${t.percentComplete}%`, background: red ? '#dc2626' : '#2563eb' }} />
                        <span className="gantt-blabel">{t.percentComplete}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {/* milestones */}
              {milestones.filter((m) => m.plannedDate).map((m) => (
                <div className="gantt-row" key={`m${m.milestoneId}`} title={`◆ ${m.name}  ${fmt(m.plannedDate as string)}  [${m.status}]`}>
                  <div className="gantt-name">◆ {m.name}{m.isPaymentMilestone && <span className="muted"> ₹</span>}</div>
                  <div className="gantt-track">
                    <span className="gantt-ms" style={{ left: `${pct(dayOf(m.plannedDate as string))}%`, color: m.status === 'ACHIEVED' || m.status === 'DONE' ? '#16a34a' : '#d97706' }}>◆</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {form && <AddForm kind={form} projectId={projectId} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
        </>
      )}
    </div>
  );
}

/** Inline create form for a task or milestone. */
function AddForm({ kind, projectId, onClose, onSaved }: { kind: 'task' | 'milestone'; projectId: number; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, val: string) => setV((s) => ({ ...s, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (kind === 'task') {
        await api.post(`/api/planning/projects/${projectId}/tasks`, {
          taskName: v.taskName, plannedStart: v.plannedStart, plannedEnd: v.plannedEnd,
          percentComplete: v.percentComplete ? Number(v.percentComplete) : 0,
        });
      } else {
        await api.post(`/api/planning/projects/${projectId}/milestones`, {
          name: v.name, plannedDate: v.plannedDate || undefined,
          isPaymentMilestone: v.isPaymentMilestone === 'true',
        });
      }
      onSaved();
    } catch (e) { const a = e as ApiError; setErr(`${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', zIndex: 1000 }} onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        style={{ width: 420, maxWidth: '92vw', background: '#fff', border: '1px solid #d8dce1', borderRadius: 6, padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>New {kind === 'task' ? 'Task' : 'Milestone'}</h3>
        {err && <div className="erp-alert erp-alert--error" role="alert">{err}</div>}
        {kind === 'task' ? (
          <>
            <Field label="Task Name *"><input className="erp-input" value={v.taskName ?? ''} onChange={(e) => set('taskName', e.target.value)} autoFocus /></Field>
            <Field label="Planned Start *"><input className="erp-input" type="date" value={v.plannedStart ?? ''} onChange={(e) => set('plannedStart', e.target.value)} /></Field>
            <Field label="Planned End *"><input className="erp-input" type="date" value={v.plannedEnd ?? ''} onChange={(e) => set('plannedEnd', e.target.value)} /></Field>
            <Field label="% Complete"><input className="erp-input" type="number" value={v.percentComplete ?? ''} onChange={(e) => set('percentComplete', e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="Milestone Name *"><input className="erp-input" value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} autoFocus /></Field>
            <Field label="Planned Date"><input className="erp-input" type="date" value={v.plannedDate ?? ''} onChange={(e) => set('plannedDate', e.target.value)} /></Field>
            <Field label="Payment milestone?">
              <select className="erp-select" value={v.isPaymentMilestone ?? 'false'} onChange={(e) => set('isPaymentMilestone', e.target.value)}>
                <option value="false">No</option><option value="true">Yes</option>
              </select>
            </Field>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="erp-btn erp-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="erp-field" style={{ marginBottom: 10 }}><label className="erp-label">{label}</label>{children}</div>;
}
