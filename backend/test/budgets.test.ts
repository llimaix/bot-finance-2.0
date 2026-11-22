import { describe, expect, it } from 'vitest';
import { budgetProgress, renderMetas, suggestBudgets } from '../src/lib/budgets';
import type { BudgetRecord, Transaction } from '../src/lib/types';

let n = 0;
const gasto = (
  amount: number,
  category = 'comida',
  date = '2026-06-10',
  description = `gasto ${++n}`,
): Transaction => ({
  sk: `TXN#${date}#b${n}`,
  date,
  shortId: n,
  amount,
  type: 'gasto',
  category,
  method: 'efectivo',
  description,
  rawMessage: '',
  createdAt: '',
});

const budget = (category: string, monthlyLimit: number): BudgetRecord => ({
  category,
  monthlyLimit,
  source: 'user',
  createdAt: '',
  updatedAt: '',
});

describe('suggestBudgets', () => {
  it('promedia meses completos y propone ~90% redondeado a Q25', () => {
    const mayo = [gasto(600, 'comida', '2026-05-05'), gasto(400, 'comida', '2026-05-20')];
    const junio = [gasto(1000, 'comida', '2026-06-08')];
    const [s] = suggestBudgets([mayo, junio], []);
    expect(s).toBeDefined();
    expect(s!.category).toBe('comida');
    expect(s!.monthlyAverage).toBe(1000); // (1000 + 1000) / 2
    expect(s!.suggested).toBe(900); // 90% de 1000, múltiplo de 25
  });

  it('excluye categorías no coacheables, con meta existente y montos chicos', () => {
    const mes = [
      gasto(500, 'deuda', '2026-06-01'), // no coacheable
      gasto(800, 'transporte', '2026-06-02'), // ya tiene meta
      gasto(50, 'regalos', '2026-06-03'), // promedio < Q100: no amerita
      gasto(300, 'comida', '2026-06-04'),
    ];
    const out = suggestBudgets([mes], [budget('transporte', 700)]);
    expect(out.map((s) => s.category)).toEqual(['comida']);
  });

  it('excluye el gasto que pertenece a recurrentes (compromisos, no consumo)', () => {
    const mes = [
      gasto(1840, 'educacion', '2026-06-06', 'Universidad Mariano Galvez'),
      gasto(500, 'comida', '2026-06-07'),
    ];
    const out = suggestBudgets(
      [mes],
      [],
      [{ tipo: 'gasto', categoria: 'educacion', descripcion: 'Universidad Mariano Galvez' }],
    );
    expect(out.map((s) => s.category)).toEqual(['comida']);
  });

  it('sin historial no sugiere nada', () => {
    expect(suggestBudgets([[], []], [])).toEqual([]);
  });
});

describe('budgetProgress', () => {
  const monthTxns = [
    gasto(300, 'comida', '2026-07-03'),
    gasto(200, 'comida', '2026-07-08'),
    gasto(100, 'transporte', '2026-07-05'),
  ];

  it('calcula gastado, %, ritmo y estado', () => {
    // comida: 500 de 1500 en 10 de 31 días → ritmo 1550 → amarillo
    // transporte: 100 de 600 → ritmo 310 → verde
    const [comida, transporte] = budgetProgress(
      [budget('comida', 1500), budget('transporte', 600)],
      monthTxns,
      10,
      31,
    );
    expect(comida!.category).toBe('comida');
    expect(comida!.spent).toBe(500);
    expect(comida!.pct).toBeCloseTo(33.33, 1);
    expect(comida!.paceProjected).toBe(1550);
    expect(comida!.status).toBe('amarillo');
    expect(transporte!.status).toBe('verde');
  });

  it('marca rojo cuando el tope ya se reventó', () => {
    const [p] = budgetProgress([budget('comida', 400)], monthTxns, 10, 31);
    expect(p!.status).toBe('rojo');
    expect(p!.pct).toBe(125);
  });

  it('ordena por % consumido descendente', () => {
    const out = budgetProgress(
      [budget('transporte', 600), budget('comida', 400)],
      monthTxns,
      10,
      31,
    );
    expect(out.map((p) => p.category)).toEqual(['comida', 'transporte']);
  });
});

describe('renderMetas', () => {
  it('sin metas invita a crearlas', () => {
    expect(renderMetas([], 10)).toContain('/metas sugerir');
  });

  it('muestra el avance con semáforo', () => {
    const [p] = budgetProgress([budget('comida', 1500)], [gasto(500, 'comida', '2026-07-03')], 10, 31);
    const text = renderMetas([p!], 10);
    expect(text).toContain('comida');
    expect(text).toContain('Q1,500.00');
  });
});
