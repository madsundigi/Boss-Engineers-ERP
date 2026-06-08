export const env = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/be',
  isTest: (process.env.NODE_ENV ?? 'development') === 'test',

  /**
   * GST e-invoice (IRN) + e-way-bill provider configuration.
   *
   * `einvoiceProvider` selects the implementation:
   *   * 'mock' (default) — deterministic offline stub; no external calls.
   *   * 'nic'            — real NIC IRP / e-Way Bill REST API. Only activated by
   *                        the factory when ALSO supplied with credentials
   *                        (base URL, client id/secret, username/password, GSTIN
   *                        and the NIC public key); otherwise it falls back to
   *                        the mock so the app never half-starts the integration.
   * All NIC values come from the taxpayer's GSP/NIC sandbox or production
   * onboarding and MUST be provided as environment variables (never committed).
   */
  einvoiceProvider: (process.env.EINVOICE_PROVIDER ?? 'mock').toLowerCase(),
  nic: {
    baseUrl: process.env.NIC_BASE_URL ?? '',
    clientId: process.env.NIC_CLIENT_ID ?? '',
    clientSecret: process.env.NIC_CLIENT_SECRET ?? '',
    username: process.env.NIC_USERNAME ?? '',
    password: process.env.NIC_PASSWORD ?? '',
    gstin: process.env.NIC_GSTIN ?? '',
    publicKey: process.env.NIC_PUBLIC_KEY ?? '', // PEM or base64 DER of NIC's cert
    // Optional endpoint-path overrides (defaults track the documented versions).
    authPath: process.env.NIC_AUTH_PATH ?? '/eivital/v1.04/auth',
    irnPath: process.env.NIC_IRN_PATH ?? '/eicore/v1.03/Invoice',
    cancelIrnPath: process.env.NIC_CANCEL_IRN_PATH ?? '/eicore/v1.03/Invoice/Cancel',
    ewayByIrnPath: process.env.NIC_EWAY_PATH ?? '/ewaybillapi/v1.03/ewayapi/GenEwayBillByIRN',
  },
};

