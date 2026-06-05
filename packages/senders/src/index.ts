import type { Provider } from '@fetch/db';
import type { SendAdapter } from './adapter';
import { InstantlyAdapter } from './instantly';
import { SmartleadAdapter } from './smartlead';
import { SmtpAdapter } from './smtp';

/**
 * @fetch/senders — SEND ADAPTERS. Each rail implements push(leads, campaign)
 * and parseEvent(payload); selecting a provider per campaign is the only switch
 * the core ever makes.
 */
export * from './adapter';
export { InstantlyAdapter } from './instantly';
export { SmartleadAdapter } from './smartlead';
export { SmtpAdapter } from './smtp';

/** Resolve the adapter for a provider name — the one place selection happens. */
export function getAdapter(provider: Provider): SendAdapter {
  switch (provider) {
    case 'instantly':
      return new InstantlyAdapter();
    case 'smartlead':
      return new SmartleadAdapter();
    case 'smtp':
      return new SmtpAdapter();
    default:
      throw new Error(`unknown send provider: ${provider}`);
  }
}

/** All adapters, for webhook routing and a capabilities view in the UI. */
export function allAdapters(): SendAdapter[] {
  return [new InstantlyAdapter(), new SmartleadAdapter(), new SmtpAdapter()];
}
