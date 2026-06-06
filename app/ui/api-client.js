/* Enquiry API client — thin fetch wrapper over the REST API.
 * In production the gateway injects identity/tenant; here we send dev headers.
 * Permission enforcement happens server-side (RBAC guard); the UI only hides
 * actions the user cannot perform. */
(function (global) {
  const BASE = global.ENQUIRY_API_BASE || '/api/enquiries';
  const ctx = global.ERP_CONTEXT || { userId: 3, companyId: 1, buId: 1 };

  function headers() {
    return {
      'Content-Type': 'application/json',
      'x-user-id': String(ctx.userId),
      'x-company-id': String(ctx.companyId),
      'x-bu-id': String(ctx.buId),
    };
  }
  async function req(method, path, body) {
    const res = await fetch(BASE + path, {
      method, headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(err?.error?.message || res.statusText), { status: res.status, body: err });
    }
    return res.status === 204 ? null : res.json();
  }

  global.EnquiryApi = {
    list: (qs = '') => req('GET', qs ? `?${qs}` : ''),
    get: (id) => req('GET', `/${id}`),
    create: (dto) => req('POST', '', dto),
    update: (id, dto) => req('PATCH', `/${id}`, dto),
    changeStatus: (id, dto) => req('POST', `/${id}/status`, dto),
    approve: (id, rowVersion) => req('POST', `/${id}/approve`, { rowVersion }),
    remove: (id) => req('DELETE', `/${id}`),
    exportUrl: () => `${BASE}/export`,
  };
})(window);
