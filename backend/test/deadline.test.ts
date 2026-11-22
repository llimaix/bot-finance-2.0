import { afterEach, describe, expect, it } from 'vitest';
import { budgetMs, fits, remainingMs, setDeadline } from '../src/lib/deadline';

const NOW = 1_000_000;

describe('deadline (M5: presupuesto de la invocación)', () => {
  afterEach(() => setDeadline(undefined));

  it('sin límite fijado (tests, eval, scripts) el tiempo es ilimitado', () => {
    expect(remainingMs(NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(budgetMs(90_000, NOW)).toBe(90_000);
    expect(fits(60_000, NOW)).toBe(true);
  });

  it('con tiempo de sobra, cada fase recibe lo que pide', () => {
    setDeadline(NOW + 165_000); // 180s de Lambda - 15s de reserva
    expect(budgetMs(90_000, NOW)).toBe(90_000);
    expect(fits(60_000, NOW)).toBe(true);
  });

  it('si la voz ya gastó tiempo, el agente recibe solo lo que queda', () => {
    setDeadline(NOW + 40_000);
    expect(budgetMs(90_000, NOW)).toBe(40_000);
  });

  it('el reintento y la red de seguridad se omiten si no caben', () => {
    setDeadline(NOW + 30_000);
    expect(fits(60_000, NOW)).toBe(false); // reintento del agente
    expect(fits(35_000, NOW)).toBe(false); // red de seguridad
  });

  it('pasado el límite queda 0, nunca negativo', () => {
    setDeadline(NOW - 5_000);
    expect(remainingMs(NOW)).toBe(0);
    expect(budgetMs(90_000, NOW)).toBe(0);
  });
});
