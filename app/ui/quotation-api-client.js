/* Quotation API client — thin fetch wrapper. Gateway injects identity/tenant in
 * prod; dev headers here. Permission checks are server-side (RBAC). */
(function (global) {
  const BASE = global.QUOTATION_API_BASE || '/api/quotations';
  const ctx = global.ERP_CONTEXT || { userId: 5, companyId: 1, buId: 1 };
  const h = () => ({ 'Content-Type': 'application/json', 'x-user-id': String(ctx.userId), 'x-company-id': String(ctx.companyId), 'x-bu-id': String(ctx.buId) });
  async function req(m, p, b) {
    const res = await fetch(BASE + p, { method: m, headers: h(), body: b ? JSON.stringify(b) : undefined });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw Object.assign(new Error(e?.error?.message || res.statusText), { status: res.status }); }
    return res.status === 204 ? null : res.json();
  }
  global.QuotationApi = {
    list: (qs = '') => req('GET', qs ? `?${qs}` : ''),
    get: (id) => req('GET', `/${id}`),
    create: (dto) => req('POST', '', dto),
    fromEnquiry: (enquiryId, dto = {}) => req('POST', `/from-enquiry/${enquiryId}`, dto),
    update: (id, dto) => req('PATCH', `/${id}`, dto),
    submit: (id, rowVersion) => req('POST', `/${id}/submit`, { rowVersion }),
    approve: (id, rowVersion) => req('POST', `/${id}/approve`, { rowVersion }),
    reject: (id, rowVersion, reason) => req('POST', `/${id}/reject`, { rowVersion, reason }),
    revise: (id, rowVersion, reason) => req('POST', `/${id}/revise`, { rowVersion, reason }),
    send: (id, dto = {}) => req('POST', `/${id}/send`, dto),
    won: (id, rowVersion) => req('POST', `/${id}/won`, { rowVersion }),
    lost: (id, rowVersion, reason) => req('POST', `/${id}/lost`, { rowVersion, reason }),
    revisions: (id) => req('GET', `/${id}/revisions`),
    pdfUrl: (id) => `${BASE}/${id}/pdf`,
  };
})(window);
