import type { RecurringRecord, Transaction } from './types';

export interface RecurringPayment {
  slug: string;
  descripcion: string;
  categoria: string;
  tipo: 'gasto' | 'ingreso';
  /** Promedio mensual de las apariciones. */
  montoTipico: number;
  /** Día del mes en que suele caer (mediana de las apariciones). */
  diaTipico: number;
  /** Meses distintos (yyyy-mm) en que apareció. */
  meses: number;
}

// Se eliminan al normalizar para que "Salario 1ra Quincena mayo 2026" y
// "...junio 2026" agrupen como el mismo concepto.
const MONTH_WORDS =
  /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g;

function normalizeDesc(desc: string): string {
  return desc
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(MONTH_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Identificador estable de un concepto recurrente (clave del item REC#). */
export function recurringSlug(category: string, description: string): string {
  return `${category}|${normalizeDesc(description)}`.replace(/\s/g, '-').slice(0, 48);
}

/** Clave de concepto de UNA transacción (los ingresos llevan prefijo propio). */
export function txnRecurringKey(t: Pick<Transaction, 'type' | 'category' | 'description'>): string {
  return `${t.type === 'ingreso' ? 'in|' : ''}${recurringSlug(t.category, t.description)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export interface DetectOptions {
  minMonths?: number;
  /** Tipos de movimiento a considerar (default: solo gastos). */
  types?: ReadonlyArray<'gasto' | 'ingreso'>;
}

/**
 * Detecta conceptos recurrentes por heurística: misma descripción normalizada
 * apareciendo en 2+ meses distintos. Cubre gastos (compromisos) y, si se pide,
 * ingresos (salarios/quincenas). Se calcula en código — el LLM solo recibe el
 * resultado para asesorar sobre él.
 */
export function detectRecurring(
  txns: ReadonlyArray<Transaction>,
  opts: DetectOptions = {},
): RecurringPayment[] {
  const minMonths = opts.minMonths ?? 2;
  const types = new Set(opts.types ?? ['gasto']);
  const groups = new Map<string, { txns: Transaction[]; months: Set<string> }>();

  for (const t of txns) {
    if (!types.has(t.type as 'gasto' | 'ingreso')) continue;
    // tipo participa en la clave para no mezclar un gasto y un ingreso homónimos
    const key = txnRecurringKey(t);
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
      tipo: group.txns[0]!.type === 'ingreso' ? 'ingreso' : 'gasto',
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
  tipo: 'gasto' | 'ingreso';
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
    monthTxns.filter((t) => t.type === 'gasto' || t.type === 'ingreso').map((t) => txnRecurringKey(t)),
  );

  const fromDetected: AdvisorRecurring[] = detected
    .filter((d) => byStatus.get(d.slug)?.status !== 'rejected')
    .map((d) => toAdvisor(d, byStatus.get(d.slug)?.status === 'confirmed', paidSlugs, todayDay));

  const detectedSlugs = new Set(detected.map((d) => d.slug));
  const confirmedMissing: AdvisorRecurring[] = known
    .filter((r) => r.status === 'confirmed' && !detectedSlugs.has(r.slug))
    .map((r) =>
      toAdvisor(
        {
          slug: r.slug,
          descripcion: r.descripcion,
          categoria: r.categoria,
          tipo: r.tipo,
          montoTipico: r.montoTipico,
          diaTipico: r.diaTipico,
          meses: 0,
        },
        true,
        paidSlugs,
        todayDay,
      ),
    );

  return [...fromDetected, ...confirmedMissing].sort((a, b) => b.montoTipico - a.montoTipico);
}

/**
 * Calendario salarial de Allan: quincenal, el 15 y el ÚLTIMO día del mes,
 * retrocedido a día hábil si cae en fin de semana. La detección trae el día
 * MEDIANO observado (varía mes a mes: 25, 29, 30...), y con él la proyección
 * daba por perdido un salario que aún venía (observado 25 vs pago real el 31).
 * Aquí se reemplaza por el día calculado del mes EN CURSO.
 */
export function applySalaryCalendar(
  recurrentes: ReadonlyArray<AdvisorRecurring>,
  paydayDays: readonly [number, number],
  todayDay: number,
): AdvisorRecurring[] {
  return recurrentes.map((r) => {
    if (r.tipo !== 'ingreso' || !/salario|quincena|sueldo/i.test(r.descripcion)) return r;
    // ≤20 = primera quincena (día ~15); >20 = fin de mes.
    const dia = r.diaTipicoDePago <= 20 ? paydayDays[0] : paydayDays[1];
    return { ...r, diaTipicoDePago: dia, aunVieneEsteMes: !r.yaPagadoEsteMes && dia >= todayDay };
  });
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
    tipo: d.tipo,
    montoTipico: d.montoTipico,
    diaTipicoDePago: d.diaTipico,
    estado: confirmed ? 'confirmado' : 'posible',
    yaPagadoEsteMes: yaPagado,
    aunVieneEsteMes: !yaPagado && d.diaTipico >= todayDay,
  };
}
