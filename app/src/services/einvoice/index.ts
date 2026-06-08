import { Pool } from 'pg';
import { env } from '../../config/env';
import logger from '../../common/logger';
import { EInvoiceProvider } from './provider';
import { MockEInvoiceProvider } from './mock.provider';
import { NicEInvoiceProvider, NicConfig } from './nic.provider';

export * from './provider';
export { MockEInvoiceProvider } from './mock.provider';
export { NicEInvoiceProvider } from './nic.provider';

/** The NIC env fields that MUST all be present to activate the real provider. */
const REQUIRED_NIC_KEYS: (keyof NicConfig)[] = [
  'baseUrl', 'clientId', 'clientSecret', 'username', 'password', 'gstin', 'publicKey',
];

/** True only when EINVOICE_PROVIDER=nic AND every required NIC credential is set. */
export function nicConfigured(): boolean {
  if (env.einvoiceProvider !== 'nic') return false;
  return REQUIRED_NIC_KEYS.every((k) => {
    const v = (env.nic as Record<string, unknown>)[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/**
 * Factory: choose the e-invoice provider.
 *   * Returns the {@link NicEInvoiceProvider} when EINVOICE_PROVIDER=nic AND all
 *     NIC credentials are configured.
 *   * Otherwise returns the {@link MockEInvoiceProvider} (the safe default), so
 *     the app never starts a half-configured live integration.
 * Logs (pino) which provider is active so it is visible at startup.
 */
export function getEInvoiceProvider(pool: Pool): EInvoiceProvider {
  if (nicConfigured()) {
    logger.info(
      { provider: 'nic', baseUrl: env.nic.baseUrl, gstin: env.nic.gstin },
      'e-invoice provider: NIC IRP (live) — verify against the NIC sandbox before production',
    );
    return new NicEInvoiceProvider(pool, { ...env.nic });
  }
  if (env.einvoiceProvider === 'nic') {
    logger.warn(
      { missing: REQUIRED_NIC_KEYS.filter((k) => !String((env.nic as Record<string, unknown>)[k] ?? '').trim()) },
      'EINVOICE_PROVIDER=nic but NIC credentials are incomplete — falling back to the mock provider',
    );
  } else {
    logger.info({ provider: 'mock' }, 'e-invoice provider: deterministic mock (default)');
  }
  return new MockEInvoiceProvider();
}
