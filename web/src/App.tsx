import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './auth/session';
import { LoginPage } from './auth/LoginPage';
import { Shell } from './app/Shell';
import { DashboardPage } from './pages/DashboardPage';
import { ResourcePage } from './pages/ResourcePage';

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
        <Route path="/r/:path" element={<ResourcePage />} />
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
