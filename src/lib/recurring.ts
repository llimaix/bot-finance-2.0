import type { RecurringRecord, Transaction } from './types';

export interface RecurringPayment {
  slug: string;
  descripcion: string;
  categoria: string;
  /** Promedio mensual de las apariciones. */
  montoTipico: number;
  /** Día del mes en que suele caer (mediana de las apariciones). */
  diaTipico: number;
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

/** Identificador estable de un concepto recurrente (clave del item REC#). */
export function recurringSlug(category: string, description: string): string {
  return `${category}|${normalizeDesc(description)}`.replace(/\s/g, '-').slice(0, 48);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
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
    const key = recurringSlug(t.category, t.description);
    const group = groups.get(key) ?? { txns: [], months: new Set<string>() };
    group.txns.push(t);
    group.months.add(t.date.slice(0, 7));
    groups.set(key, group);
  }

  const recurring: RecurringPayment[] = [];
  for (const [slug, group] of groups) {
    if (group.months.size < minMonths) continue;
    const monthlyTotals = new Map<string, number>();
    for (const t of group.txns) {
      const m = t.date.slice(0, 7);
      monthlyTotals.set(m, round2((monthlyTotals.get(m) ?? 0) + t.amount));
    }
    const avg = round2([...monthlyTotals.values()].reduce((a, b) => a + b, 0) / monthlyTotals.size);
    recurring.push({
      slug,
      descripcion: group.txns[0]!.description,
      categoria: group.txns[0]!.category,
      montoTipico: avg,
      diaTipico: median(group.txns.map((t) => Number(t.date.slice(8, 10)))),
      meses: group.months.size,
    });
  }

  return recurring.sort((a, b) => b.montoTipico - a.montoTipico);
}

/** Candidatos detectados que aún no existen en la base de conocimientos REC#. */
export function findNewCandidates(
  detected: ReadonlyArray<RecurringPayment>,
  known: ReadonlyArray<RecurringRecord>,
): RecurringPayment[] {
  const knownSlugs = new Set(known.map((r) => r.slug));
  return detected.filter((d) => !knownSlugs.has(d.slug));
}

export interface AdvisorRecurring {
  descripcion: string;
  categoria: string;
  montoTipico: number;
  diaTipicoDePago: number;
  estado: 'confirmado' | 'posible';
  yaPagadoEsteMes: boolean;
  aunVieneEsteMes: boolean;
}

/**
 * Vista para el asesor: heurística fresca + estado aprendido (REC#).
 * Los rechazados se excluyen; los confirmados que la heurística ya no ve
 * (p.ej. trimestrales) se conservan con sus datos guardados.
 */
export function recurringForAdvisor(
  detected: ReadonlyArray<RecurringPayment>,
  known: ReadonlyArray<RecurringRecord>,
  monthTxns: ReadonlyArray<Transaction>,
  todayDay: number,
): AdvisorRecurring[] {
  const byStatus = new Map(known.map((r) => [r.slug, r]));
  const paidSlugs = new Set(
    monthTxns.filter((t) => t.type === 'gasto').map((t) => recurringSlug(t.category, t.description)),
  );

  const fromDetected: AdvisorRecurring[] = detected
    .filter((d) => byStatus.get(d.slug)?.status !== 'rejected')
    .map((d) => toAdvisor(d, byStatus.get(d.slug)?.status === 'confirmed', paidSlugs, todayDay));

  const detectedSlugs = new Set(detected.map((d) => d.slug));
  const confirmedMissing: AdvisorRecurring[] = known
    .filter((r) => r.status === 'confirmed' && !detectedSlugs.has(r.slug))
    .map((r) =>
      toAdvisor(
        { slug: r.slug, descripcion: r.descripcion, categoria: r.categoria, montoTipico: r.montoTipico, diaTipico: r.diaTipico, meses: 0 },
        true,
        paidSlugs,
        todayDay,
      ),
    );

  return [...fromDetected, ...confirmedMissing].sort((a, b) => b.montoTipico - a.montoTipico);
}

function toAdvisor(
  d: RecurringPayment,
  confirmed: boolean,
  paidSlugs: ReadonlySet<string>,
  todayDay: number,
): AdvisorRecurring {
  const yaPagado = paidSlugs.has(d.slug);
  return {
    descripcion: d.descripcion,
    categoria: d.categoria,
    montoTipico: d.montoTipico,
    diaTipicoDePago: d.diaTipico,
    estado: confirmed ? 'confirmado' : 'posible',
    yaPagadoEsteMes: yaPagado,
    aunVieneEsteMes: !yaPagado && d.diaTipico >= todayDay,
  };
}
