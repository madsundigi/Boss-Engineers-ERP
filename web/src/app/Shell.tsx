import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../auth/session';
import { SECTIONS } from './registry';

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();

  return (
    <div className="erp-shell">
      <header className="erp-topbar">
        <span className="brand" style={{ fontWeight: 700 }}>Boss Engineers ERP</span>
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
      </nav>

      <main className="erp-content">
        {children}
      </main>
    </div>
  );
}
