import { useState, FormEvent, CSSProperties } from 'react';
import { ApiError } from '../api/client';
import { FormField, DocFormDef, LineField } from '../app/registry';

type Mode = 'create' | 'edit';
type Vals = Record<string, string>;
type LineVals = Record<string, string>;

interface Props {
  title: string;
  fields: FormField[];
  onClose: () => void;
  /** called after a successful create/edit so the list can refresh */
  onSaved: () => void;
  /** does the POST (create) or PATCH (edit); receives the built payload */
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  mode?: Mode;
  /** pre-filled header values (edit mode); values are stringified for inputs */
  initialValues?: Vals;
  /** repeatable line-item editor config (header + N lines documents) */
  doc?: DocFormDef;
  /** pre-filled line rows (edit mode), stringified per cell */
  initialLines?: LineVals[];
}

// Robust overlay positioning (independent of the design-system default display).
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center', zIndex: 1000,
};
const dialog: CSSProperties = {
  width: 720, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto',
  background: 'var(--c-surface, #fff)', border: '1px solid var(--c-border, #d8dce1)',
  borderRadius: 6, boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
};

function emptyLine(fields: LineField[]): LineVals {
  return Object.fromEntries(fields.map((f) => [f.name, '']));
}

export function ResourceForm({
  title, fields, onClose, onSaved, onSubmit,
  mode = 'create', initialValues, doc, initialLines,
}: Props) {
  const [values, setValues] = useState<Vals>(initialValues ?? {});
  const [lines, setLines] = useState<LineVals[]>(
    doc ? (initialLines && initialLines.length ? initialLines : [emptyLine(doc.lineFields)]) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }));
  const setLine = (i: number, name: string, v: string) =>
    setLines((rows) => rows.map((r, ri) => (ri === i ? { ...r, [name]: v } : r)));
  const addLine = () => doc && setLines((rows) => [...rows, emptyLine(doc.lineFields)]);
  const removeLine = (i: number) => setLines((rows) => rows.filter((_, ri) => ri !== i));

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

    if (doc) {
      // keep only rows that have at least one non-empty cell
      const filled = lines.filter((r) => doc.lineFields.some((f) => r[f.name]?.trim() !== ''));
      if (doc.minLines && filled.length < doc.minLines) {
        setError(`At least ${doc.minLines} line is required.`);
        return;
      }
      for (const r of filled) {
        const missingCells = doc.lineFields.filter((f) => f.required && !r[f.name]);
        if (missingCells.length) {
          setError(`Each line needs: ${doc.lineFields.filter((f) => f.required).map((f) => f.label).join(', ')}`);
          return;
        }
      }
      payload[doc.lineKey] = filled.map((r) => {
        const out: Record<string, unknown> = {};
        for (const f of doc.lineFields) {
          const raw = r[f.name];
          if (raw == null || raw === '') continue;
          out[f.name] = f.type === 'number' ? Number(raw) : raw;
        }
        return out;
      });
    }

    setBusy(true);
    setError(null);
    try {
      await onSubmit(payload);
      onSaved();
    } catch (err) {
      const a = err as ApiError;
      if (a.status === 409) {
        setError('This record was changed by someone else — reload the list and try again.');
      } else {
        setError(`${a.message}${a.status ? ` (HTTP ${a.status})` : ''}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div className="erp-modal__dialog" style={dialog} role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}>
        <div className="erp-modal__head">
          <span className="erp-modal__title">{mode === 'edit' ? 'Edit' : 'New'} {title}</span>
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

            {doc && (
              <div style={{ marginTop: 18 }}>
                <div className="erp-table-toolbar" style={{ marginBottom: 6 }}>
                  <strong>Lines</strong>
                  <button type="button" className="erp-btn erp-btn--sm" style={{ marginLeft: 'auto' }}
                    onClick={addLine}>+ Add line</button>
                </div>
                <table className="erp-table">
                  <thead>
                    <tr>
                      {doc.lineFields.map((f) => (
                        <th key={f.name} className={f.type === 'number' ? 'cell-num' : undefined}>
                          {f.label}{f.required && ' *'}
                        </th>
                      ))}
                      <th aria-label="remove" style={{ width: 36 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 && (
                      <tr><td colSpan={doc.lineFields.length + 1} className="muted" style={{ padding: 12 }}>
                        No lines.
                      </td></tr>
                    )}
                    {lines.map((row, i) => (
                      <tr key={i}>
                        {doc.lineFields.map((f) => (
                          <td key={f.name}>
                            {f.type === 'select' ? (
                              <select className="erp-select" value={row[f.name] ?? ''}
                                onChange={(e) => setLine(i, f.name, e.target.value)}>
                                <option value="">—</option>
                                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            ) : (
                              <input className="erp-input"
                                type={f.type === 'number' ? 'number' : 'text'}
                                value={row[f.name] ?? ''}
                                onChange={(e) => setLine(i, f.name, e.target.value)} />
                            )}
                          </td>
                        ))}
                        <td>
                          <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost"
                            aria-label="Remove line" title="Remove line"
                            onClick={() => removeLine(i)}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="erp-modal__foot">
            <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="erp-btn erp-btn--primary" disabled={busy}>
              {busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
