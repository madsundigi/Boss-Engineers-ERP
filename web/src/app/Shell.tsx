import { ReactNode, useState, FormEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../auth/session';
import { SECTIONS } from './registry';

/** Global search box (Central Search Engine entry point) — navigates to /search?q=… */
function TopSearch() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const t = term.trim();
    if (t) navigate(`/search?q=${encodeURIComponent(t)}`);
  }
  return (
    <form onSubmit={submit} role="search" style={{ flex: '0 1 360px', margin: '0 16px' }}>
      <input className="erp-input" value={term} aria-label="Global search"
        placeholder="Search everything…  ⏎"
        onChange={(e) => setTerm(e.target.value)} />
    </form>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();

  return (
    <div className="erp-shell">
      <header className="erp-topbar">
        <span className="brand" style={{ fontWeight: 700 }}>Boss Engineers ERP</span>
        <TopSearch />
        <span className="topbar-spacer" />
        <span className="api-pill">Company #{user?.companyId}</span>
        <span className="erp-avatar" title={user?.username}>
          {(user?.username ?? '?').slice(0, 2).toUpperCase()}
        </span>
        <button className="erp-btn erp-btn--ghost erp-btn--sm" onClick={logout}>Sign out</button>
      </header>

      <nav className="erp-sidebar" aria-label="Primary">
        <NavLink to="/" end
          className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
          <span className="erp-nav__icon">▤</span> Dashboard
        </NavLink>
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="erp-nav__section">{section.label}</div>
            {section.items.map((item) => (
              <NavLink key={item.path} to={`/r/${item.path}`}
                className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
                <span className="erp-nav__icon">▷</span> {item.label}
              </NavLink>
            ))}
          </div>
        ))}

        <div>
          <div className="erp-nav__section">Analytics</div>
          {[
            ['/reports/service-kpis', 'Service KPIs'],
            ['/reports/pareto', 'Failure Pareto'],
            ['/reports/forecast', 'Revenue Forecast'],
            ['/reports/delivery-risk', 'Delivery Risk'],
          ].map(([to, label]) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
              <span className="erp-nav__icon">▷</span> {label}
            </NavLink>
          ))}
        </div>

        <div>
          <div className="erp-nav__section">Administration</div>
          <NavLink to="/users"
            className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
            <span className="erp-nav__icon">▷</span> Users
          </NavLink>
          <NavLink to="/roles"
            className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
            <span className="erp-nav__icon">▷</span> Roles
          </NavLink>
        </div>
      </nav>

      <main className="erp-content">
        {children}
      </main>
    </div>
  );
}
