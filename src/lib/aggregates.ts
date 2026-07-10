import type { Category, Method, Transaction } from './types';

/** Umbral de "gasto hormiga": gastos individuales ≤ Q50. */
export const HORMIGA_THRESHOLD = 50;

export interface CategoryAggregate {
  sum: number;
  count: number;
}

export interface Aggregates {
  txnCount: number;
  totalGastos: number;
  totalIngresos: number;
  totalAhorro: number;
  /** Solo gastos, ordenado se deja al renderer. */
  byCategory: Partial<Record<Category, CategoryAggregate>>;
  /** Solo gastos. */
  byMethod: Partial<Record<Method, number>>;
  /** Gasto promedio por día del período. */
  dailyAverage: number;
  top5: Array<{ description: string; category: Category; amount: number }>;
  hormiga: { count: number; sum: number; threshold: number };
  comparison: { prevTotalGastos: number; deltaPct: number | null } | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Todos los números del reporte se calculan AQUÍ, en código — el LLM solo narra.
 */
export function computeAggregates(
  txns: Transaction[],
  daysInPeriod: number,
  prevTxns?: Transaction[],
): Aggregates {
  const gastos = txns.filter((t) => t.type === 'gasto');

  const byCategory: Partial<Record<Category, CategoryAggregate>> = {};
  const byMethod: Partial<Record<Method, number>> = {};
  for (const g of gastos) {
    const cat = (byCategory[g.category] ??= { sum: 0, count: 0 });
    cat.sum = round2(cat.sum + g.amount);
    cat.count += 1;
    byMethod[g.method] = round2((byMethod[g.method] ?? 0) + g.amount);
  }

  const totalGastos = round2(gastos.reduce((acc, t) => acc + t.amount, 0));
  const totalIngresos = round2(
    txns.filter((t) => t.type === 'ingreso').reduce((acc, t) => acc + t.amount, 0),
  );
  const totalAhorro = round2(
    txns
      .filter((t) => t.type === 'deposito' && t.category === 'ahorro')
      .reduce((acc, t) => acc + t.amount, 0),
  );

  const top5 = [...gastos]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({ description: t.description, category: t.category, amount: t.amount }));

  const hormigaTxns = gastos.filter((t) => t.amount <= HORMIGA_THRESHOLD);
  const hormiga = {
    count: hormigaTxns.length,
    sum: round2(hormigaTxns.reduce((acc, t) => acc + t.amount, 0)),
    threshold: HORMIGA_THRESHOLD,
  };

  let comparison: Aggregates['comparison'] = null;
  if (prevTxns && prevTxns.length > 0) {
    const prevTotalGastos = round2(
      prevTxns.filter((t) => t.type === 'gasto').reduce((acc, t) => acc + t.amount, 0),
    );
    comparison = {
      prevTotalGastos,
      deltaPct: prevTotalGastos > 0 ? round2(((totalGastos - prevTotalGastos) / prevTotalGastos) * 100) : null,
    };
  }

  return {
    txnCount: txns.length,
    totalGastos,
    totalIngresos,
    totalAhorro,
    byCategory,
    byMethod,
    dailyAverage: daysInPeriod > 0 ? round2(totalGastos / daysInPeriod) : 0,
    top5,
    hormiga,
    comparison,
  };
}
