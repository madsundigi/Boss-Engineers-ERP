import { useEffect, useState, FormEvent, ReactNode, CSSProperties } from 'react';
import { api, ApiError } from '../api/client';

// ---- API shapes -----------------------------------------------------------
interface UserRow {
  userId: number;
  username: string;
  email: string;
  fullName: string;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
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

// ---- Modal helper (mirrors ResourceForm's overlay + dialog pattern) --------
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

/** Checkbox list of every role; selection lifted via `selected` + `onToggle`. */
function RolePicker({ roles, selected, onToggle }: {
  roles: RoleDef[]; selected: Set<string>; onToggle: (code: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto' }}>
      {roles.map((r) => (
        <label key={r.roleCode} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.has(r.roleCode)}
            onChange={() => onToggle(r.roleCode)} style={{ marginTop: 3 }} />
          <span>
            <span className="cell-mono" style={{ fontWeight: 600 }}>{r.roleCode}</span>
            {r.roleName && <span className="muted"> — {r.roleName}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

// The API wraps errors as { error: { code, message, details } }. The thin client
// puts that whole body on `err.details`, so we read the human-readable message
// (and any policy `violations` / Zod field errors) out of the nested envelope.
interface ServerEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: { violations?: unknown; fieldErrors?: Record<string, string[]>; formErrors?: string[] } | unknown;
  };
}

/** Turn an ApiError into a user-facing message; expands 400 policy violations. */
function describeError(err: ApiError, fallback?: string): string {
  if (err.status === 403) return 'You need user-admin permission to perform this action.';
  const env = (err.details as ServerEnvelope | undefined)?.error;
  const detail = env?.details as
    | { violations?: unknown; fieldErrors?: Record<string, string[]>; formErrors?: string[] }
    | undefined;

  // password-policy failures: { details: { violations: string[] } }
  if (Array.isArray(detail?.violations) && detail.violations.length) {
    return (detail.violations as unknown[]).map(String).join(' ');
  }
  // Zod validation failures: flatten() -> { fieldErrors, formErrors }
  if (detail && (detail.fieldErrors || detail.formErrors)) {
    const parts = [
      ...(detail.formErrors ?? []),
      ...Object.entries(detail.fieldErrors ?? {}).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`),
    ].filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  // otherwise use the server's own message (already human-readable)
  const msg = env?.message
    ?? (typeof err.message === 'string' ? err.message : undefined)
    ?? fallback
    ?? 'Something went wrong.';
  if (err.status === 409 && !env?.message) {
    return fallback ?? 'This record was changed by someone else — reload and try again.';
  }
  return `${msg}${err.status ? ` (HTTP ${err.status})` : ''}`;
}

function fmtDate(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

// ---------------------------------------------------------------------------
export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // modal state: at most one open at a time
  const [showCreate, setShowCreate] = useState(false);
  const [rolesFor, setRolesFor] = useState<UserRow | null>(null);
  const [pwdFor, setPwdFor] = useState<UserRow | null>(null);

  const refresh = () => setReload((n) => n + 1);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<UsersResponse>('/api/users'),
      api.get<RoleDef[]>('/api/roles'),
    ])
      .then(([u, r]) => { if (!live) return; setUsers(u.rows); setRoles(r); })
      .catch((e: ApiError) => { if (live) setError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reload]);

  async function toggleActive(u: UserRow) {
    const verb = u.isActive ? 'Deactivate' : 'Activate';
    if (!window.confirm(`${verb} user "${u.username}"?`)) return;
    setActionError(null);
    setBusyId(u.userId);
    try {
      await api.patch(`/api/users/${u.userId}`, { isActive: !u.isActive, rowVersion: u.rowVersion });
      refresh();
    } catch (err) {
      setActionError(describeError(err as ApiError, 'This user was changed elsewhere — reload and try again.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Users</h1>
        {!error && (
          <button className="erp-btn erp-btn--primary" onClick={() => { setActionError(null); setShowCreate(true); }}>
            + New User
          </button>
        )}
      </div>

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403
            ? 'You need user-admin permission (USER_MGMT) to view this page.'
            : `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`}
        </div>
      )}
      {actionError && <div className="erp-alert erp-alert--error" role="alert">{actionError}</div>}

      <div className="erp-table-wrap">
        <div className="erp-table-toolbar">
          <strong>Users</strong>
          <span className="muted" style={{ marginLeft: 8 }}>{loading ? '' : `${users.length} user(s)`}</span>
        </div>
        {loading ? (
          <div className="spinner">Loading…</div>
        ) : (
          <table className="erp-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Full Name</th>
                <th>Email</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Last Login</th>
                <th style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>No users.</td></tr>
              )}
              {users.map((u) => {
                const rowBusy = busyId === u.userId;
                return (
                  <tr key={u.userId}>
                    <td className="cell-mono">{u.username}</td>
                    <td>{u.fullName}</td>
                    <td>{u.email}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {u.roleCodes.length === 0
                          ? <span className="muted">—</span>
                          : u.roleCodes.map((c) => <span key={c} className="erp-badge">{c}</span>)}
                      </div>
                    </td>
                    <td>
                      <span className={`erp-badge ${u.isActive ? 'erp-badge--approved' : 'erp-badge--rejected'}`}>
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{fmtDate(u.lastLoginAt)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="erp-btn erp-btn--sm" disabled={rowBusy}
                          onClick={() => { setActionError(null); setRolesFor(u); }}>Roles</button>
                        <button type="button" className="erp-btn erp-btn--sm" disabled={rowBusy}
                          onClick={() => { setActionError(null); setPwdFor(u); }}>Password</button>
                        <button type="button"
                          className={`erp-btn erp-btn--sm ${u.isActive ? 'erp-btn--danger' : ''}`}
                          disabled={rowBusy}
                          onClick={() => toggleActive(u)}>
                          {rowBusy ? '…' : u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreateUserModal roles={roles}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); refresh(); }} />
      )}
      {rolesFor && (
        <EditRolesModal user={rolesFor} roles={roles}
          onClose={() => setRolesFor(null)}
          onSaved={() => { setRolesFor(null); refresh(); }} />
      )}
      {pwdFor && (
        <ResetPasswordModal user={pwdFor}
          onClose={() => setPwdFor(null)}
          onSaved={() => setPwdFor(null)} />
      )}
    </div>
  );
}

// ---- Create user ----------------------------------------------------------
function CreateUserModal({ roles, onClose, onSaved }: {
  roles: RoleDef[]; onClose: () => void; onSaved: () => void;
}) {
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (code: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !fullName || !email || !password) {
      setError('Username, full name, email and password are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/users', {
        username, email, fullName, password, roleCodes: Array.from(selected),
      });
      onSaved();
    } catch (err) {
      const a = err as ApiError;
      setError(a.status === 409
        ? `Username "${username}" is already taken.`
        : describeError(a));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New User" onClose={onClose}
      foot={<>
        <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="create-user-form" className="erp-btn erp-btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Create'}
        </button>
      </>}>
      <form id="create-user-form" onSubmit={submit}>
        <div className="erp-modal__body">
          {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}
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
              <label className="erp-label">Roles</label>
              <RolePicker roles={roles} selected={selected} onToggle={toggle} />
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---- Edit roles -----------------------------------------------------------
function EditRolesModal({ user, roles, onClose, onSaved }: {
  user: UserRow; roles: RoleDef[]; onClose: () => void; onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(user.roleCodes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (code: string) => setSelected((s) => {
    const next = new Set(s);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/users/${user.userId}/roles`, { roleCodes: Array.from(selected) });
      onSaved();
    } catch (err) {
      setError(describeError(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Roles — ${user.username}`} onClose={onClose}
      foot={<>
        <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="edit-roles-form" className="erp-btn erp-btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save Roles'}
        </button>
      </>}>
      <form id="edit-roles-form" onSubmit={submit}>
        <div className="erp-modal__body">
          {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}
          <RolePicker roles={roles} selected={selected} onToggle={toggle} />
        </div>
      </form>
    </Modal>
  );
}

// ---- Reset password -------------------------------------------------------
function ResetPasswordModal({ user, onClose, onSaved }: {
  user: UserRow; onClose: () => void; onSaved: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) { setError('Enter a new password.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/users/${user.userId}/password`, { password });
      setDone(true);
    } catch (err) {
      setError(describeError(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset Password — ${user.username}`} onClose={onClose}
      foot={done
        ? <button type="button" className="erp-btn erp-btn--primary" onClick={onSaved}>Done</button>
        : <>
            <button type="button" className="erp-btn" onClick={onClose}>Cancel</button>
            <button type="submit" form="reset-pwd-form" className="erp-btn erp-btn--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Set Password'}
            </button>
          </>}>
      <form id="reset-pwd-form" onSubmit={submit}>
        <div className="erp-modal__body">
          {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}
          {done ? (
            <div className="erp-alert erp-alert--success" role="status">Password updated.</div>
          ) : (
            <div className="erp-form__grid">
              <div className="erp-field erp-field--12">
                <label className="erp-label">New Password <span style={{ color: 'var(--c-error, #b00)' }}>*</span></label>
                <input className="erp-input" type="password" value={password}
                  onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                <span className="erp-field__hint">Min 12 chars, with upper, lower, digit & symbol.</span>
              </div>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
