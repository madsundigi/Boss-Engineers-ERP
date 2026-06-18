import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { FilterDef } from '../app/registry';

export type FilterValues = Record<string, string>;

interface UserOption { value: string; label: string }
interface UsersResponse { rows: { userId: number; username: string; fullName: string }[] }

/** Serialize non-empty filter values into a query string (no leading '?').
 *  Each filter's `param` (falling back to `key`) is the query-param name. */
export function buildFilterQuery(filters: FilterDef[], values: FilterValues): string {
  const params = new URLSearchParams();
  for (const f of filters) {
    const v = values[f.key];
    if (v != null && v.trim() !== '') params.set(f.param ?? f.key, v.trim());
  }
  return params.toString();
}

/** Count of filters currently holding a non-empty value. */
export function activeFilterCount(filters: FilterDef[], values: FilterValues): number {
  return filters.reduce((n, f) => (values[f.key]?.trim() ? n + 1 : n), 0);
}

/**
 * Registry-driven, multi-field filter bar. Holds its own input state and lifts
 * every change via `onChange`; the parent owns fetching. `text` inputs are
 * debounced (~350ms) before lifting; select/date/user apply immediately.
 *
 * For `type:'user'` it fetches `/api/users` once on mount and renders a select
 * whose chosen value is the user id (sent as the param).
 */
export function FilterBar({ filters, onChange }: {
  filters: FilterDef[];
  onChange: (values: FilterValues) => void;
}) {
  const [values, setValues] = useState<FilterValues>({});
  const [open, setOpen] = useState(true);
  const [users, setUsers] = useState<UserOption[]>([]);

  const hasUserFilter = filters.some((f) => f.type === 'user');

  // Fetch the user list once (only when a 'user' filter exists) for its <select>.
  useEffect(() => {
    if (!hasUserFilter) return;
    let live = true;
    api.get<UsersResponse>('/api/users')
      .then((res) => {
        if (!live) return;
        setUsers((res.rows ?? []).map((u) => ({
          value: String(u.userId),
          label: u.fullName || u.username,
        })));
      })
      .catch(() => { /* leave the select empty (just the blank "Any") on failure */ });
    return () => { live = false; };
  }, [hasUserFilter]);

  // Debounce text inputs; apply select/date/user immediately. We diff the
  // serialized value so a debounced text edit and an immediate select change
  // don't race: the latest `values` snapshot is what gets lifted either way.
  const serialized = JSON.stringify(values);
  useEffect(() => {
    const anyText = filters.some((f) => f.type === 'text');
    if (!anyText) { onChange(values); return; }
    const t = setTimeout(() => onChange(values), 350);
    return () => clearTimeout(t);
    // re-run whenever any value changes (serialized) or the def list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  const clear = () => setValues({});

  const count = activeFilterCount(filters, values);

  return (
    <div className="erp-card erp-filter-bar">
      <div className="erp-filter-bar__head">
        <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm"
          aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Filters
        </button>
        {count > 0 && (
          <span className="erp-badge erp-badge--progress" aria-live="polite">
            {count} filter{count === 1 ? '' : 's'}
          </span>
        )}
        <span className="erp-filter-bar__spacer" />
        <button type="button" className="erp-btn erp-btn--sm"
          onClick={clear} disabled={count === 0}>Clear</button>
      </div>

      {open && (
        <div className="erp-filter-bar__grid">
          {filters.map((f) => {
            const id = `filter-${f.key}`;
            const val = values[f.key] ?? '';
            return (
              <div key={f.key} className="erp-field erp-filter-bar__field">
                <label className="erp-label" htmlFor={id}>{f.label}</label>
                {f.type === 'text' && (
                  <input id={id} className="erp-input" type="text"
                    value={val} placeholder={f.placeholder ?? ''}
                    onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.type === 'date' && (
                  <input id={id} className="erp-input" type="date"
                    value={val} onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.type === 'select' && (
                  <select id={id} className="erp-select"
                    value={val} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">Any</option>
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {f.type === 'user' && (
                  <select id={id} className="erp-select"
                    value={val} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">Any</option>
                    {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
