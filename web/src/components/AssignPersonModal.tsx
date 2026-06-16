import { useEffect, useState, FormEvent, ReactNode, CSSProperties } from 'react';
import { api, ApiError } from '../api/client';

// ---- API shapes -----------------------------------------------------------
interface UserRow {
  userId: number;
  username: string;
  fullName: string;
  email: string;
  isActive: boolean;
  rowVersion: number;
  roleCodes: string[];
}
interface UsersResponse { rows: UserRow[]; total: number }
interface RoleDef {
  roleCode: string;
  roleName: string;
  description: string;
  permissions: string[];
}

interface Props {
  enquiryId: unknown;
  rowVersion?: unknown;
  currentAssignee?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

// ---- Modal helper (mirrors ResourceForm / UsersPage overlay + dialog) ------
const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'grid', placeItems: 'center', zIndex: 1000,
};
const dialog: CSSProperties = {
  width: 560, maxWidth: '92vw', maxHeight: '88vh', overflow: 'auto',
  background: 'var(--c-surface, #fff)', border: '1px solid var(--c-border, #d8dce1)',
  borderRadius: 6, boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
};

function Modal({ title, onClose, children, foot }: {
  title: string; onClose: () => void; children: ReactNode; foot: ReactNode;
}) {
  return (
    <div style={overlay} onClick={onClose}>
      <div className="erp-modal__dialog" style={dialog} role="dialog" aria-modal="true"
        onClick={(e) => e.stopPropagation()}>
        <div className="erp-modal__head">
          <span className="erp-modal__title">{title}</span>
          <button type="button" className="erp-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
        <div className="erp-modal__foot">{foot}</div>
      </div>
    </div>
  );
}

// The API wraps errors as { error: { code, message, details } }; surface the
// human-readable message (and any zod field errors) like the rest of the app.
interface ServerEnvelope {
  error?: {
    message?: string;
    details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | unknown;
  };
}
function describeError(err: ApiError, fallback?: string): string {
  if (err.status === 403) return 'You do not have permission to assign this enquiry.';
  const env = (err.details as ServerEnvelope | undefined)?.error;
  const detail = env?.details as
    | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
    | undefined;
  if (detail && (detail.fieldErrors || detail.formErrors)) {
    const parts = [
      ...(detail.formErrors ?? []),
      ...Object.entries(detail.fieldErrors ?? {}).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`),
    ].filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (err.status === 409) {
    return env?.message ?? fallback ?? 'This enquiry was changed by someone else — reload and try again.';
  }
  const msg = env?.message ?? err.message ?? fallback ?? 'Something went wrong.';
  return `${msg}${err.status ? ` (HTTP ${err.status})` : ''}`;
}

// ---------------------------------------------------------------------------
export function AssignPersonModal({ enquiryId, rowVersion, currentAssignee, onClose, onSaved }: Props) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [pickedUserId, setPickedUserId] = useState<number | null>(null);

  // create-user fields
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.get<UsersResponse>('/api/users'),
      api.get<RoleDef[]>('/api/roles'),
    ])
      .then(([u, r]) => { if (!live) return; setUsers(u.rows); setRoles(r); })
      .catch((e: ApiError) => { if (live) setLoadError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  // POST /api/enquiries/:id/assign — shared by both modes.
  async function assign(userId: number) {
    const sid = encodeURIComponent(String(enquiryId));
    await api.post(`/api/enquiries/${sid}/assign`, { userId, rowVersion });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'pick') {
      if (pickedUserId == null) { setError('Select a user to assign.'); return; }
      setBusy(true);
      try {
        await assign(pickedUserId);
        onSaved();
      } catch (err) {
        setError(describeError(err as ApiError));
      } finally {
        setBusy(false);
      }
      return;
    }

    // create mode: make the user, then assign the returned id.
    if (!username || !fullName || !email || !password) {
      setError('Username, full name, email and password are required.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<UserRow>('/api/users', {
        username, email, fullName, password,
        roleCodes: roleCode ? [roleCode] : [],
      });
      await assign(created.userId);
      onSaved();
    } catch (err) {
      const a = err as ApiError;
      setError(a.status === 409 && /user|username/i.test(a.message ?? '')
        ? `Username "${username}" is already taken.`
        : describeError(a));
    } finally {
      setBusy(false);
    }
  }

  const foot = (
    <>
      <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="assign-person-form" className="erp-btn erp-btn--primary"
        disabled={busy || loading || !!loadError}>
        {busy ? 'Saving…' : 'Save & Assign'}
      </button>
    </>
  );

  return (
    <Modal title="Assign Enquiry" onClose={onClose} foot={foot}>
      <form id="assign-person-form" onSubmit={submit}>
        <div className="erp-modal__body">
          {currentAssignee && (
            <div className="muted" style={{ marginBottom: 10 }}>
              Currently assigned to <strong>{currentAssignee}</strong>.
            </div>
          )}
          {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}
          {loadError && (
            <div className={`erp-alert ${loadError.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
              {loadError.status === 403
                ? 'You need user-admin permission (USER_MGMT) to list/create users.'
                : `${loadError.message}${loadError.status ? ` (HTTP ${loadError.status})` : ''}`}
            </div>
          )}

          {/* mode toggle */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button type="button"
              className={`erp-btn erp-btn--sm ${mode === 'pick' ? 'erp-btn--primary' : ''}`}
              onClick={() => { setMode('pick'); setError(null); }}>Pick existing user</button>
            <button type="button"
              className={`erp-btn erp-btn--sm ${mode === 'create' ? 'erp-btn--primary' : ''}`}
              onClick={() => { setMode('create'); setError(null); }}>Create new user</button>
          </div>

          {loading ? (
            <div className="spinner">Loading users…</div>
          ) : mode === 'pick' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflow: 'auto' }}>
              {users.length === 0 && <span className="muted">No users found.</span>}
              {users.map((u) => (
                <label key={u.userId}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '6px 8px', borderRadius: 4,
                    background: pickedUserId === u.userId ? 'var(--c-bg-subtle, #eef2ff)' : 'transparent' }}>
                  <input type="radio" name="assign-user" checked={pickedUserId === u.userId}
                    onChange={() => setPickedUserId(u.userId)} disabled={!u.isActive} />
                  <span style={{ flex: 1 }}>
                    <span style={{ fontWeight: 600 }}>{u.fullName || u.username}</span>
                    {u.fullName && <span className="muted cell-mono"> ({u.username})</span>}
                    {!u.isActive && <span className="muted"> — inactive</span>}
                  </span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {u.roleCodes.length === 0
                      ? <span className="muted">—</span>
                      : <span className="erp-badge">{u.roleCodes.join(', ')}</span>}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="erp-form__grid">
              <div className="erp-field erp-field--6">
                <label className="erp-label">Username <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                <input className="erp-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
              </div>
              <div className="erp-field erp-field--6">
                <label className="erp-label">Full Name <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                <input className="erp-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="erp-field erp-field--6">
                <label className="erp-label">Email <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                <input className="erp-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </div>
              <div className="erp-field erp-field--6">
                <label className="erp-label">Password <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                <input className="erp-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                <span className="erp-field__hint">Min 12 chars, with upper, lower, digit & symbol.</span>
              </div>
              <div className="erp-field erp-field--12">
                <label className="erp-label">Role</label>
                <select className="erp-select" value={roleCode} onChange={(e) => setRoleCode(e.target.value)}>
                  <option value="">—</option>
                  {roles.map((r) => (
                    <option key={r.roleCode} value={r.roleCode}>
                      {r.roleCode}{r.roleName ? ` — ${r.roleName}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
