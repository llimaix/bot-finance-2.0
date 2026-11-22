import { formatQ } from './format';
import { txnRecurringKey } from './recurring';
import type { BudgetRecord, Transaction } from './types';

/** Lo mínimo de un recurrente para excluirlo de las sugerencias (estructural:
 *  lo cumplen tanto RecurringRecord como AdvisorRecurring). */
export interface RecurringLike {
  tipo: 'gasto' | 'ingreso';
  categoria: string;
  descripcion: string;
}

/** Categorías que no tiene sentido presupuestar (compromisos, no consumo). */
const NON_COACHABLE = new Set(['deuda', 'ahorro', 'inversion', 'otros']);

const MAX_SUGGESTIONS = 5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BudgetSuggestion {
  category: string;
  /** Promedio mensual observado en los meses completos disponibles. */
  monthlyAverage: number;
  /** Meta propuesta: ~90% del promedio, redondeada a Q25. */
  suggested: number;
}

/**
 * Sugiere metas para las categorías VARIABLES con más gasto, a partir del
 * promedio de meses completos anteriores. Excluye lo recurrente (eso ya es
 * compromiso fijo, no consumo coacheable) y las categorías con meta existente.
 */
export function suggestBudgets(
  prevMonths: ReadonlyArray<ReadonlyArray<Transaction>>,
  existing: ReadonlyArray<BudgetRecord>,
  recurrentes: ReadonlyArray<RecurringLike> = [],
): BudgetSuggestion[] {
  const months = prevMonths.filter((m) => m.length > 0);
  if (months.length === 0) return [];

  const recurringKeys = new Set(
    recurrentes
      .filter((r) => r.tipo === 'gasto')
      .map((r) => txnRecurringKey({ type: 'gasto', category: r.categoria, description: r.descripcion })),
  );
  const alreadySet = new Set(existing.map((b) => b.category));

  const totals = new Map<string, number>();
  for (const month of months) {
    for (const t of month) {
      if (t.type !== 'gasto') continue;
      if (NON_COACHABLE.has(t.category) || alreadySet.has(t.category)) continue;
      if (recurringKeys.has(txnRecurringKey(t))) continue;
      totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
    }
  }

  return [...totals.entries()]
    .map(([category, total]) => {
      const monthlyAverage = round2(total / months.length);
      // Meta alcanzable pero exigente: 90% del promedio, en múltiplos de Q25.
      const suggested = Math.max(25, Math.round((monthlyAverage * 0.9) / 25) * 25);
      return { category, monthlyAverage, suggested };
    })
    .filter((s) => s.monthlyAverage >= 100) // categorías chicas no ameritan meta
    .sort((a, b) => b.monthlyAverage - a.monthlyAverage)
    .slice(0, MAX_SUGGESTIONS);
}

export interface BudgetProgress extends BudgetRecord {
  /** Gastado del mes en la categoría. */
  spent: number;
  /** % del tope ya consumido (0-∞). */
  pct: number;
  /** Gasto proyectado a fin de mes al ritmo actual. */
  paceProjected: number;
  /** verde = va bien, amarillo = el ritmo se pasa, rojo = tope reventado. */
  status: 'verde' | 'amarillo' | 'rojo';
}

/** Progreso del mes contra cada meta. Todos los números se calculan aquí. */
export function budgetProgress(
  budgets: ReadonlyArray<BudgetRecord>,
  monthTxns: ReadonlyArray<Transaction>,
  daysElapsed: number,
  daysInMonth: number,
): BudgetProgress[] {
  return budgets
    .map((b) => {
      const spent = round2(
        monthTxns
          .filter((t) => t.type === 'gasto' && t.category === b.category)
          .reduce((acc, t) => acc + t.amount, 0),
      );
      const paceProjected = daysElapsed > 0 ? round2((spent / daysElapsed) * daysInMonth) : spent;
      const pct = b.monthlyLimit > 0 ? round2((spent / b.monthlyLimit) * 100) : 0;
      const status: BudgetProgress['status'] =
        spent > b.monthlyLimit ? 'rojo' : paceProjected > b.monthlyLimit ? 'amarillo' : 'verde';
      return { ...b, spent, pct, paceProjected, status };
    })
    .sort((a, b) => b.pct - a.pct);
}

const STATUS_EMOJI: Record<BudgetProgress['status'], string> = {
  verde: '🟢',
  amarillo: '🟡',
  rojo: '🔴',
};

/** Mensaje del comando /metas (sin argumentos). */
export function renderMetas(progress: ReadonlyArray<BudgetProgress>, daysElapsed: number): string {
  if (progress.length === 0) {
    return [
      '🎯 Aún no tienes metas de gasto.',
      '',
      'Ponlas con /metas sugerir (te propongo topes según tu historial) o directo: /metas comida 1500',
    ].join('\n');
  }
  const lines = [`🎯 <b>Tus metas del mes</b> (al día ${daysElapsed}):`, ''];
  for (const p of progress) {
    lines.push(
      `${STATUS_EMOJI[p.status]} ${p.category}: ${formatQ(p.spent)} de ${formatQ(p.monthlyLimit)} (${Math.round(p.pct)}%)` +
        (p.status === 'amarillo' ? ` · a este ritmo: ${formatQ(p.paceProjected)}` : ''),
    );
  }
  lines.push('', 'Ajusta: /metas comida 1500 · quita: /metas quitar comida · más: /metas sugerir');
  return lines.join('\n');
}

/** Umbrales de aviso al registrar: 80 % y 100 % del tope. */
const CRUCES = [100, 80] as const;

/**
 * Avisos de meta al registrar (fase 6). Solo avisa cuando lo recién
 * registrado CRUZA un umbral (antes por debajo, ahora en o por encima): así no
 * se repite en cada gasto. `monthTxns` ya incluye los nuevos movimientos.
 */
export function budgetCrossings(
  budgets: ReadonlyArray<BudgetRecord>,
  monthTxns: ReadonlyArray<Transaction>,
  newTxns: ReadonlyArray<Transaction>,
  month: string,
): string[] {
  const avisos: string[] = [];
  for (const b of budgets) {
    if (b.monthlyLimit <= 0) continue;
    const esGasto = (t: Transaction) => t.type === 'gasto' && t.category === b.category && t.date.startsWith(month);
    const nuevo = newTxns.filter(esGasto).reduce((a, t) => a + t.amount, 0);
    if (nuevo <= 0) continue;
    const despues = monthTxns.filter(esGasto).reduce((a, t) => a + t.amount, 0);
    const pctAntes = ((despues - nuevo) / b.monthlyLimit) * 100;
    const pctDespues = (despues / b.monthlyLimit) * 100;
    const cruce = CRUCES.find((u) => pctAntes < u && pctDespues >= u);
    if (cruce === undefined) continue;
    avisos.push(
      cruce === 100
        ? `🔴 Pasaste tu meta de ${b.category}: ${formatQ(round2(despues))} de ${formatQ(b.monthlyLimit)} (${Math.round(pctDespues)}%).`
        : `🟡 Llevas el ${Math.round(pctDespues)}% de tu meta de ${b.category}: ${formatQ(round2(despues))} de ${formatQ(b.monthlyLimit)}.`,
    );
  }
  return avisos;
}
