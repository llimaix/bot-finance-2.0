import { describe, expect, it } from 'vitest';
import { computeAggregates } from '../src/lib/aggregates';
import type { Transaction } from '../src/lib/types';

let counter = 0;
function txn(partial: Partial<Transaction>): Transaction {
  counter += 1;
  return {
    sk: `TXN#2026-06-0${counter}#x${counter}`,
    date: '2026-06-01',
    shortId: counter,
    amount: 10,
    type: 'gasto',
    category: 'otros',
    method: 'efectivo',
    description: `mov ${counter}`,
    rawMessage: '',
    createdAt: '2026-06-01T12:00:00Z',
    ...partial,
  };
}

describe('computeAggregates', () => {
  it('separa gastos, ingresos y ahorro', () => {
    const agg = computeAggregates(
      [
        txn({ amount: 100, type: 'gasto', category: 'comida' }),
        txn({ amount: 50, type: 'gasto', category: 'transporte' }),
        txn({ amount: 3000, type: 'ingreso', category: 'otros' }),
        txn({ amount: 500, type: 'deposito', category: 'ahorro' }),
        txn({ amount: 200, type: 'retiro', method: 'debito' }),
      ],
      30,
    );
    expect(agg.totalGastos).toBe(150);
    expect(agg.totalIngresos).toBe(3000);
    expect(agg.totalAhorro).toBe(500);
    expect(agg.txnCount).toBe(5);
    expect(agg.dailyAverage).toBe(5);
  });

  it('agrupa por categoría y método solo los gastos', () => {
    const agg = computeAggregates(
      [
        txn({ amount: 40, category: 'comida', method: 'efectivo' }),
        txn({ amount: 60, category: 'comida', method: 'credito' }),
        txn({ amount: 100, category: 'hogar', method: 'credito' }),
        txn({ amount: 999, type: 'ingreso', category: 'otros' }),
      ],
      10,
    );
    expect(agg.byCategory.comida).toEqual({ sum: 100, count: 2 });
    expect(agg.byCategory.hogar).toEqual({ sum: 100, count: 1 });
    expect(agg.byCategory.otros).toBeUndefined();
    expect(agg.byMethod.credito).toBe(160);
    expect(agg.byMethod.efectivo).toBe(40);
  });

  it('detecta gastos hormiga (≤ Q50)', () => {
    const agg = computeAggregates(
      [
        txn({ amount: 15 }),
        txn({ amount: 50 }),
        txn({ amount: 51 }),
        txn({ amount: 20, type: 'ingreso' }),
      ],
      30,
    );
    expect(agg.hormiga).toEqual({ count: 2, sum: 65, threshold: 50 });
  });

  it('top 5 ordenado descendente', () => {
    const agg = computeAggregates(
      [10, 500, 30, 200, 90, 45, 300].map((amount) => txn({ amount })),
      30,
    );
    expect(agg.top5.map((t) => t.amount)).toEqual([500, 300, 200, 90, 45]);
  });

  it('comparativa contra el período anterior', () => {
    const agg = computeAggregates([txn({ amount: 120 })], 30, [txn({ amount: 100 })]);
    expect(agg.comparison).toEqual({ prevTotalGastos: 100, deltaPct: 20 });
  });

  it('sin datos previos no hay comparativa', () => {
    const agg = computeAggregates([txn({ amount: 120 })], 30, []);
    expect(agg.comparison).toBeNull();
  });
});
