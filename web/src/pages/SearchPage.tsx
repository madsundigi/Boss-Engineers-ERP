import { useEffect, useState, FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';

interface SearchHit { id: number; no: string; title: string; subtitle: string | null; path: string | null }
interface SearchGroup { type: string; label: string; hits: SearchHit[] }
interface SearchResults { query: string; groups: SearchGroup[]; total: number }

/**
 * Central Search Engine (lifecycle traceability). Reads `?q=` from the URL, calls
 * GET /api/search, and renders the cross-entity hits grouped by module. Each hit
 * with a `path` deep-links to that module's list screen.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [term, setTerm] = useState(q);
  const [data, setData] = useState<SearchResults | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setTerm(q); }, [q]);

  useEffect(() => {
    if (!q.trim()) { setData(null); setError(null); return; }
    setLoading(true); setError(null);
    api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}&limit=10`)
      .then(setData)
      .catch((e: ApiError) => setError(e))
      .finally(() => setLoading(false));
  }, [q]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setParams(term.trim() ? { q: term.trim() } : {});
  }

  return (
    <div className="erp-page erp-stack">
      <div className="erp-page__head">
        <h1 className="erp-page__title">Search</h1>
      </div>

      <form onSubmit={submit} role="search" style={{ maxWidth: 560 }}>
        <input className="erp-input" value={term} autoFocus
          placeholder="Customer name, Enquiry / Quote / Project / Serial / Ticket No…"
          aria-label="Search" onChange={(e) => setTerm(e.target.value)} />
      </form>

      {error && (
        <div className="erp-alert erp-alert--error" role="alert">
          {error.status === 403 ? 'Your role lacks permission to search these records.' : error.message}
        </div>
      )}
      {loading && <div className="spinner">Searching…</div>}
      {!loading && data && data.total === 0 && (
        <div className="muted">No matches for “{q}”.</div>
      )}

      {data && data.groups.map((g) => (
        <div className="erp-panel" key={g.type}>
          <div className="erp-panel__head">
            {g.label} <span className="muted">({g.hits.length})</span>
          </div>
          <div className="erp-panel__body" style={{ padding: 0 }}>
            <table className="erp-table">
              <thead>
                <tr><th>No</th><th>Name</th><th>Status</th><th aria-label="open" style={{ width: 80 }}></th></tr>
              </thead>
              <tbody>
                {g.hits.map((h) => (
                  <tr key={`${g.type}-${h.id}`}>
                    <td className="mono">{h.no}</td>
                    <td>{h.title}</td>
                    <td>{h.subtitle ?? '—'}</td>
                    <td>{h.path ? <Link className="linklike" to={`/r/${h.path}`}>Open ›</Link> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
