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
    // API errors are enveloped as { error: { code, message, details } }; some
    // paths return a bare { message } or { error: "..." }. Extract a readable
    // string, and flatten zod field errors (details.fieldErrors) into
    // "field: message" lines so the user sees WHICH field failed.
    const env = (data && data.error) || data || {};
    let message: string =
      typeof env === 'string' ? env : env.message || res.statusText || 'Request failed';
    const fieldErrors = env && env.details && env.details.fieldErrors;
    if (fieldErrors && typeof fieldErrors === 'object') {
      const parts = Object.entries(fieldErrors as Record<string, string[]>)
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`);
      if (parts.length) message = parts.join(' · ');
    }
    throw { status: res.status, message, details: data } as ApiError;
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
