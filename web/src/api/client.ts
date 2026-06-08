// Thin typed fetch client for the ERP API. Base URL is configurable (dev proxy,
// deployed API, or the Electron desktop pointing at a remote host).
const DEFAULT_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:3001';

export function apiBase(): string {
  return localStorage.getItem('apiBase') || DEFAULT_BASE;
}
export function setApiBase(url: string): void {
  localStorage.setItem('apiBase', url.replace(/\/$/, ''));
}

export interface ApiError {
  status: number;
  message: string;
  details?: unknown;
}

function authToken(): string | null {
  return localStorage.getItem('token');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = authToken();
  if (t) headers.authorization = `Bearer ${t}`;

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw { status: 0, message: `Cannot reach the API at ${apiBase()}` } as ApiError;
  }

  if (res.status === 401) {
    localStorage.removeItem('token');
    window.dispatchEvent(new Event('auth:logout'));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw {
      status: res.status,
      message: (data && (data.message || data.error)) || res.statusText,
      details: data,
    } as ApiError;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
