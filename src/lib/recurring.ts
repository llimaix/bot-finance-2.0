import type { Transaction } from './types';

export interface RecurringPayment {
  descripcion: string;
  categoria: string;
  /** Promedio mensual de las apariciones. */
  montoTipico: number;
  /** Meses distintos (yyyy-mm) en que apareció. */
  meses: number;
}

function normalizeDesc(desc: string): string {
  return desc
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Detecta pagos recurrentes por heurística: mismo concepto (descripción
 * normalizada) apareciendo en 2+ meses distintos. Se calcula en código —
 * el LLM solo recibe el resultado para asesorar sobre él.
 */
export function detectRecurring(txns: ReadonlyArray<Transaction>, minMonths = 2): RecurringPayment[] {
  const groups = new Map<string, { txns: Transaction[]; months: Set<string> }>();

  for (const t of txns) {
    if (t.type !== 'gasto') continue;
    const key = `${t.category}|${normalizeDesc(t.description)}`;
    const group = groups.get(key) ?? { txns: [], months: new Set<string>() };
    group.txns.push(t);
    group.months.add(t.date.slice(0, 7));
    groups.set(key, group);
  }

  const recurring: RecurringPayment[] = [];
  for (const group of groups.values()) {
    if (group.months.size < minMonths) continue;
    const monthlyTotals = new Map<string, number>();
    for (const t of group.txns) {
      const m = t.date.slice(0, 7);
      monthlyTotals.set(m, round2((monthlyTotals.get(m) ?? 0) + t.amount));
    }
    const avg = round2([...monthlyTotals.values()].reduce((a, b) => a + b, 0) / monthlyTotals.size);
    recurring.push({
      descripcion: group.txns[0]!.description,
      categoria: group.txns[0]!.category,
      montoTipico: avg,
      meses: group.months.size,
    });
  }

  return recurring.sort((a, b) => b.montoTipico - a.montoTipico);
}
