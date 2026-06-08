import { useState, FormEvent } from 'react';
import { useSession } from './session';
import { apiBase, setApiBase, ApiError } from '../api/client';

export function LoginPage() {
  const { login } = useSession();
  const [username, setUsername] = useState('admin_user');
  const [password, setPassword] = useState('');
  const [companyId, setCompanyId] = useState('1');
  const [buId, setBuId] = useState('1');
  const [base, setBase] = useState(apiBase());
  const [editBase, setEditBase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setApiBase(base);
    try {
      await login(username, password,
        companyId ? Number(companyId) : undefined,
        buId ? Number(buId) : undefined);
    } catch (err) {
      const a = err as ApiError;
      setError(a.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Boss Engineers ERP</h1>
        <p className="sub">Sign in to continue</p>

        {error && <div className="erp-alert erp-alert--error" role="alert">{error}</div>}

        <div className="erp-field">
          <label className="erp-label" htmlFor="u">Username</label>
          <input id="u" className="erp-input" value={username}
            onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="erp-field">
          <label className="erp-label" htmlFor="p">Password</label>
          <input id="p" className="erp-input" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="erp-field">
          <label className="erp-label" htmlFor="c">Company ID</label>
          <input id="c" className="erp-input" value={companyId}
            onChange={(e) => setCompanyId(e.target.value)} />
        </div>
        <div className="erp-field">
          <label className="erp-label" htmlFor="bu">Branch (BU) ID</label>
          <input id="bu" className="erp-input" value={buId}
            onChange={(e) => setBuId(e.target.value)} />
        </div>

        <button className="erp-btn erp-btn--primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div style={{ marginTop: 12, fontSize: 11 }}>
          {editBase ? (
            <div className="erp-field" style={{ marginBottom: 0 }}>
              <label className="erp-label" htmlFor="b">API base URL</label>
              <input id="b" className="erp-input" value={base}
                onChange={(e) => setBase(e.target.value)} />
            </div>
          ) : (
            <button type="button" className="linklike" onClick={() => setEditBase(true)}>
              API: {base}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
