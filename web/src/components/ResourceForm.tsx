import { useState, FormEvent, CSSProperties } from 'react';
import { api, ApiError } from '../api/client';
import { FormField } from '../app/registry';

interface Props {
  title: string;
  endpoint: string;
  fields: FormField[];
  onClose: () => void;
  onCreated: () => void;
}

// Robust overlay positioning (independent of the design-system default display).
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center', zIndex: 1000,
};
const dialog: CSSProperties = {
  width: 640, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto',
  background: 'var(--c-surface, #fff)', border: '1px solid var(--c-border, #d8dce1)',
  borderRadius: 6, boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
};

export function ResourceForm({ title, endpoint, fields, onClose, onCreated }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const missing = fields.filter((f) => f.required && !values[f.name]);
    if (missing.length) {
      setError(`Required: ${missing.map((m) => m.label).join(', ')}`);
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (raw == null || raw === '') continue;
      payload[f.name] = f.type === 'number' ? Number(raw) : raw;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(endpoint, payload);
      onCreated();
    } catch (err) {
      const a = err as ApiError;
      setError(`${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div className="erp-modal__dialog" style={dialog} role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}>
        <div className="erp-modal__head">
          <span className="erp-modal__title">New {title}</span>
          <button type="button" className="erp-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={submit}>
          <div className="erp-modal__body">
            {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}
            <div className="erp-form__grid">
              {fields.map((f) => (
                <div className="erp-field erp-field--6" key={f.name}>
                  <label className="erp-label">
                    {f.label}{f.required && <span style={{ color: 'var(--c-error, #b00)' }}> *</span>}
                  </label>
                  {f.type === 'textarea' ? (
                    <textarea className="erp-textarea" value={values[f.name] ?? ''}
                      onChange={(e) => set(f.name, e.target.value)} />
                  ) : f.type === 'select' ? (
                    <select className="erp-select" value={values[f.name] ?? ''}
                      onChange={(e) => set(f.name, e.target.value)}>
                      <option value="">—</option>
                      {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input className="erp-input"
                      type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      value={values[f.name] ?? ''} placeholder={f.placeholder}
                      onChange={(e) => set(f.name, e.target.value)} />
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="erp-modal__foot">
            <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="erp-btn erp-btn--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
