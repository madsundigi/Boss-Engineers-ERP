import {
  createContext, useContext, useState, useEffect, ReactNode, useCallback,
} from 'react';
import { api } from '../api/client';

export interface SessionUser {
  userId: number;
  username: string;
  companyId: number;
  buId: number | null;
  fullName?: string;
}

interface LoginResponse {
  token: string;
  user: { userId: number; username: string; companyId: number; buId: number | null; fullName?: string };
  permissions: string[];
}

interface SessionCtx {
  user: SessionUser | null;
  permissions: Set<string>;
  login: (username: string, password: string, companyId?: number, buId?: number) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
}

const Ctx = createContext<SessionCtx>(null!);
export function useSession(): SessionCtx {
  return useContext(Ctx);
}

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => load<SessionUser | null>('user', null));
  const [permissions, setPermissions] = useState<Set<string>>(
    () => new Set(load<string[]>('perms', [])));

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('perms');
    setUser(null);
    setPermissions(new Set());
  }, []);

  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, [logout]);

  const login = useCallback(async (
    username: string, password: string, companyId?: number, buId?: number,
  ) => {
    const r = await api.post<LoginResponse>('/auth/login', { username, password, companyId, buId });
    const u: SessionUser = {
      userId: r.user.userId, username: r.user.username, companyId: r.user.companyId,
      buId: r.user.buId, fullName: r.user.fullName,
    };
    localStorage.setItem('token', r.token);
    localStorage.setItem('user', JSON.stringify(u));
    localStorage.setItem('perms', JSON.stringify(r.permissions));
    setUser(u);
    setPermissions(new Set(r.permissions));
  }, []);

  const can = useCallback((perm: string) => permissions.has(perm), [permissions]);

  return (
    <Ctx.Provider value={{ user, permissions, login, logout, can }}>
      {children}
    </Ctx.Provider>
  );
}
