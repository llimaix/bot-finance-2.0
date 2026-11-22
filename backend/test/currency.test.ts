import { describe, expect, it } from 'vitest';
import { toQuetzales } from '../src/lib/currency';

const base = {
  type: 'gasto' as const,
  category: 'suscripciones',
  method: 'credito' as const,
  date: null,
};

describe('toQuetzales', () => {
  it('convierte USD a Q con la convención de la ingesta en la descripción', () => {
    const out = toQuetzales(
      { ...base, amount: 100, currency: 'USD', description: 'Anthropic, PBC - Max plan' },
      7.8,
    );
    expect(out.amount).toBe(780);
    expect(out.description).toBe('Anthropic, PBC - Max plan (USD 100 ≈ Q780 a 7.80)');
    expect('currency' in out).toBe(false);
  });

  it('redondea a 2 decimales (Apple $10.99 → Q85.72)', () => {
    const out = toQuetzales(
      { ...base, amount: 10.99, currency: 'USD', description: 'Apple.com/bill' },
      7.8,
    );
    expect(out.amount).toBe(85.72);
  });

  it('GTQ pasa intacto (solo pierde el campo currency)', () => {
    const out = toQuetzales({ ...base, amount: 45, currency: 'GTQ', description: 'almuerzo' }, 7.8);
    expect(out.amount).toBe(45);
    expect(out.description).toBe('almuerzo');
    expect('currency' in out).toBe(false);
  });

  it('conserva el resto de los campos', () => {
    const out = toQuetzales(
      { ...base, amount: 20, currency: 'USD', description: 'x', date: '2026-07-13' },
      7.8,
    );
    expect(out.type).toBe('gasto');
    expect(out.method).toBe('credito');
    expect(out.date).toBe('2026-07-13');
  });
});
