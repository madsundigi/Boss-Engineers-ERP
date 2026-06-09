import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './auth/session';
import { LoginPage } from './auth/LoginPage';
import { Shell } from './app/Shell';
import { DashboardPage } from './pages/DashboardPage';
import { ResourcePage } from './pages/ResourcePage';
import { SearchPage } from './pages/SearchPage';
import { ServiceKpisPage } from './pages/ServiceKpisPage';
import { FailureParetoPage } from './pages/FailureParetoPage';
import { RevenueForecastPage } from './pages/RevenueForecastPage';
import { DeliveryRiskPage } from './pages/DeliveryRiskPage';
import { UsersPage } from './pages/UsersPage';
import { RolesPage } from './pages/RolesPage';

function AppRoutes() {
  const { user } = useSession();

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/reports/service-kpis" element={<ServiceKpisPage />} />
        <Route path="/reports/pareto" element={<FailureParetoPage />} />
        <Route path="/reports/forecast" element={<RevenueForecastPage />} />
        <Route path="/reports/delivery-risk" element={<DeliveryRiskPage />} />
        <Route path="/r/:path" element={<ResourcePage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  return (
    <SessionProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </SessionProvider>
  );
}
