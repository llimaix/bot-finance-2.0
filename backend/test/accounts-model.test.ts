import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/lib/config';

describe('config.accountsModel (interruptor de la migración)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('v2 solo cuando la variable lo dice explícitamente', () => {
    vi.stubEnv('ACCOUNTS_MODEL', 'v2');
    expect(config.accountsModel).toBe('v2');
  });

  it('sin variable, vacía o con un valor desconocido queda en v1 (lo que ya funciona)', () => {
    for (const valor of ['', 'v1', 'V2', 'v3', 'true']) {
      vi.stubEnv('ACCOUNTS_MODEL', valor);
      expect(config.accountsModel, valor).toBe('v1');
    }
  });
});
