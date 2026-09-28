import type { ProviderRequestResult } from '../types.js';

export interface FootballProvider {
  name: string;
  mode: 'live' | 'mock';
  /** Perform a provider request. Endpoint is the API-Football path (e.g. `/fixtures`). */
  get<T = unknown>(endpoint: string, params: Record<string, unknown>): Promise<ProviderRequestResult<T>>;
  /** Cheap credential/quota verification. */
  verifyCredentials(): Promise<{ ok: boolean; detail: string; quota?: unknown }>;
}

let providerSingleton: FootballProvider | null = null;

export function setProvider(p: FootballProvider): void {
  providerSingleton = p;
}

export async function getProvider(): Promise<FootballProvider> {
  if (!providerSingleton) {
    const { config } = await import('../config.js');
    if (config.providerMode === 'live') {
      const { ApiFootballClient } = await import('./apifootball.js');
      providerSingleton = new ApiFootballClient();
    } else {
      const { MockFootballProvider } = await import('./mock.js');
      providerSingleton = new MockFootballProvider();
    }
  }
  return providerSingleton;
}
