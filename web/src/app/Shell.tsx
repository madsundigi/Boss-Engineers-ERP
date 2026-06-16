import { ReactNode, useState, FormEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../auth/session';
import { SECTIONS } from './registry';
import { Icon, iconForPath } from '../components/Icon';
import { FollowupReminder } from '../components/FollowupReminder';

type IconName = Parameters<typeof Icon>[0]['name'];

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
    <form onSubmit={submit} role="search" className="erp-topbar__search" style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-muted)', display: 'grid' }}>
        <Icon name="search" size={16} />
      </span>
      <input className="erp-input" value={term} aria-label="Global search"
        placeholder="Search enquiries, quotes, projects…"
        style={{ paddingLeft: 36, height: 38, background: 'var(--c-surface-alt)' }}
        onChange={(e) => setTerm(e.target.value)} />
    </form>
  );
}

const ANALYTICS: [string, string, IconName][] = [
  ['/reports/service-kpis', 'Service KPIs', 'activity'],
  ['/reports/pareto', 'Failure Pareto', 'bar'],
  ['/reports/forecast', 'Revenue Forecast', 'trending'],
  ['/reports/delivery-risk', 'Delivery Risk', 'truck'],
  ['/reports/warranty-cost', 'Warranty Cost', 'dollar'],
];

function NavItem({ to, end, icon, label }: { to: string; end?: boolean; icon: IconName; label: string }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => 'erp-nav__item' + (isActive ? ' is-active' : '')}>
      <span className="erp-nav__icon"><Icon name={icon} size={18} /></span> {label}
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();

  return (
    <div className="erp-shell">
      <FollowupReminder />
      <header className="erp-topbar">
        <span className="erp-topbar__brand">
          <span className="erp-topbar__logo"><Icon name="bolt" size={18} /></span>
          Boss Engineers
        </span>
        <TopSearch />
        <span className="erp-topbar__spacer" />
        <button className="erp-topbar__icon" title="Notifications" aria-label="Notifications">
          <Icon name="bell" size={18} />
        </button>
        <span className="api-pill" title="Active company">Company #{user?.companyId}</span>
        <span className="erp-topbar__user" title={user?.username}>
          <span className="erp-avatar">{(user?.username ?? '?').slice(0, 2).toUpperCase()}</span>
          <span style={{ fontSize: 'var(--fs-13)', fontWeight: 600, color: 'var(--c-text)' }}>{user?.username}</span>
        </span>
        <button className="erp-btn erp-btn--ghost erp-btn--sm" onClick={logout}>Sign out</button>
      </header>

      <nav className="erp-sidebar" aria-label="Primary">
        <NavItem to="/" end icon="grid" label="Dashboard" />
        <NavItem to="/planning" icon="gantt" label="Planning (Gantt)" />

        {SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="erp-nav__section">{section.label}</div>
            {section.items.map((item) => (
              <NavItem key={item.path} to={`/r/${item.path}`} icon={iconForPath(item.path)} label={item.label} />
            ))}
          </div>
        ))}

        <div>
          <div className="erp-nav__section">Analytics</div>
          {ANALYTICS.map(([to, label, icon]) => (
            <NavItem key={to} to={to} icon={icon} label={label} />
          ))}
        </div>

        <div>
          <div className="erp-nav__section">Administration</div>
          <NavItem to="/users" icon="users" label="Users" />
          <NavItem to="/roles" icon="settings" label="Roles" />
        </div>
      </nav>

      <main className="erp-content">
        {children}
      </main>
    </div>
  );
}
