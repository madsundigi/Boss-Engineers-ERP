// Minimal i18n scaffold. The app's English strings live here; add locale dicts
// to `locales` and call setLocale() to switch. Components call t('key', {vars}).
// Kept dependency-free; swap for react-intl/i18next later without changing call sites.
type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Boss Engineers ERP',
  'auth.signIn': 'Sign in',
  'auth.signingIn': 'Signing in…',
  'auth.username': 'Username',
  'auth.password': 'Password',
  'auth.companyId': 'Company ID',
  'nav.dashboard': 'Dashboard',
  'common.records': '{n} record(s)',
  'common.loading': 'Loading…',
  'common.noRecords': 'No records.',
  'common.signOut': 'Sign out',
  'rbac.noAccess': 'You do not have permission to view this (RBAC). Try a role that owns this module.',
};

const locales: Record<string, Dict> = { en };
let current = 'en';

export function setLocale(locale: string): void {
  if (locales[locale]) current = locale;
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  let s = locales[current][key] ?? en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}
