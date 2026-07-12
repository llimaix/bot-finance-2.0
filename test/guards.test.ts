import { describe, expect, it } from 'vitest';
import { registrationWarnings } from '../src/lib/guards';
import type { Transaction } from '../src/lib/types';

let n = 0;
const txn = (partial: Partial<Transaction>): Transaction => ({
  sk: `TXN#2026-07-12#g${++n}`,
  date: '2026-07-12',
  shortId: n,
  amount: 45,
  type: 'gasto',
  category: 'comida',
  method: 'efectivo',
  description: 'almuerzo',
  rawMessage: '',
  createdAt: '',
  ...partial,
});

describe('registrationWarnings', () => {
  it('avisa cuando el nuevo coincide en fecha+monto+categoría con uno existente', () => {
    const existing = [txn({ sk: 'TXN#2026-07-12#viejo', shortId: 1, description: 'almuerzo tacos' })];
    const nuevo = txn({ shortId: 2 });
    const warnings = registrationWarnings([nuevo, ...existing.slice(0, 0)], [...existing, nuevo]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Posible duplicado');
    expect(warnings[0]).toContain('#1');
  });

  it('no se acusa a sí mismo (mismo lote) ni a montos/categorías distintos', () => {
    const a = txn({ shortId: 1, amount: 45 });
    const b = txn({ shortId: 2, amount: 46 });
    const warnings = registrationWarnings([a, b], [a, b]);
    expect(warnings).toHaveLength(0);
  });

  it('avisa de montos grandes', () => {
    const grande = txn({ shortId: 3, amount: 12_000 });
    const warnings = registrationWarnings([grande], [grande]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Monto grande');
  });
});
