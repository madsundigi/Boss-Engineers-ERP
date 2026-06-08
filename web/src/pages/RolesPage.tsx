import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface RoleDef {
  roleCode: string;
  roleName: string;
  description: string;
  permissions: string[];
}

/** Read-only catalog of the least-privilege roles and the permissions each grants. */
export function RolesPage() {
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api.get<RoleDef[]>('/api/roles')
      .then((r) => { if (live) setRoles(r); })
      .catch((e: ApiError) => { if (live) setError(e); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Roles</h1>
      </div>

      {error && (
        <div className={`erp-alert ${error.status === 403 ? 'erp-alert--warning' : 'erp-alert--error'}`} role="alert">
          {error.status === 403
            ? 'You need role-admin permission (ROLE_MGMT) to view this page.'
            : `${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`}
        </div>
      )}

      {loading && !error && <div className="spinner">Loading roles…</div>}

      {!loading && !error && roles.length === 0 && (
        <div className="erp-panel"><div className="erp-panel__body muted">No roles defined.</div></div>
      )}

      <div className="erp-stack">
        {roles.map((r) => (
          <div className="erp-panel" key={r.roleCode}>
            <div className="erp-panel__head">
              <span>
                <span className="cell-mono" style={{ fontWeight: 700 }}>{r.roleCode}</span>
                {r.roleName && <span className="muted" style={{ marginLeft: 8 }}>{r.roleName}</span>}
              </span>
              <span className="erp-badge">{r.permissions.length} permission(s)</span>
            </div>
            <div className="erp-panel__body">
              {r.description && <p style={{ marginTop: 0 }}>{r.description}</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {r.permissions.length === 0
                  ? <span className="muted">No permissions.</span>
                  : r.permissions.map((p) => (
                      <span key={p} className="erp-badge cell-mono">{p}</span>
                    ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
