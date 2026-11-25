/**
 * Cifras de "libre" (diseño, sección 7). PURO.
 *
 * Libre hasta el próximo ingreso = disponible hoy (sin crédito)
 *   − pagos de tarjeta pendientes con fecha de pago ≤ próximo ingreso
 *   − recurrentes pendientes hasta esa fecha
 *   − gasto variable diario × días hasta esa fecha.
 * Libre después del ingreso = lo anterior + monto del ingreso − obligaciones
 * hasta el ingreso siguiente (la tarjeta del próximo corte se estima con lo
 * consumido en el periodo actual).
 * El crédito disponible NO es libre: es deuda potencial.
 */
import { escapeHtml } from '../format';
import { fechaPago } from './ciclos';
import type { IngresoEsperado } from './ingresos';
import { formatCents } from './money';
import { totales } from './balance';
import type { SaldoV2 } from './saldos';
import type { TarjetaConCiclo } from './tarjetas';

export interface RecurrenteLibre {
  descripcion: string;
  montoCentavos: number;
  dia: number;
  /** false si ya se pagó este mes. */
  aunVieneEsteMes: boolean;
}

export interface LibreInput {
  hoy: string;
  saldos: ReadonlyArray<SaldoV2>;
  tarjetas: ReadonlyArray<TarjetaConCiclo>;
  proximos: ReadonlyArray<{ ingreso: IngresoEsperado; fecha: string }>;
  recurrentes: ReadonlyArray<RecurrenteLibre>;
  gastoDiarioCentavos: number;
}

interface Partida {
  concepto: string;
  fecha: string;
  montoCentavos: number;
}

export interface Libre {
  disponible: number;
  /** Deuda de tarjetas. */
  deuda: number;
  /** Deuda de préstamos: no entra en el libre (la cuota sí, como obligación). */
  prestamos: number;
  ingreso: { descripcion: string; fecha: string; montoCentavos: number } | null;
  dias: number;
  tarjetas: Partida[];
  recurrentes: Partida[];
  gastoVariable: number;
  libreHastaIngreso: number | null;
  despues: { hasta: string; libre: number } | null;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fecha = (iso: string): string => `${Number(iso.slice(8, 10))}-${MESES[Number(iso.slice(5, 7)) - 1]}`;
const ms = (s: string): number => Date.parse(`${s}T00:00:00Z`);
const diasEntre = (a: string, b: string): number => Math.max(0, Math.round((ms(b) - ms(a)) / 86_400_000));
const suma = (xs: ReadonlyArray<Partida>): number => xs.reduce((a, x) => a + x.montoCentavos, 0);

/** Fechas de un recurrente (día del mes) dentro de (desde, hasta]. */
function fechasRecurrente(r: RecurrenteLibre, desde: string, hasta: string, hoy: string): string[] {
  const out: string[] = [];
  const d = new Date(ms(desde));
  for (let k = 0; k < 3; k++) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + k;
    const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const f = new Date(Date.UTC(y, m, Math.min(r.dia, ultimo))).toISOString().slice(0, 10);
    // Este mes y ya pagado → no cuenta.
    if (f.slice(0, 7) === hoy.slice(0, 7) && !r.aunVieneEsteMes) continue;
    if (f > desde && f <= hasta) out.push(f);
  }
  return out;
}

function recurrentesEntre(input: LibreInput, desde: string, hasta: string): Partida[] {
  return input.recurrentes.flatMap((r) =>
    fechasRecurrente(r, desde, hasta, input.hoy).map((f) => ({ concepto: r.descripcion, fecha: f, montoCentavos: r.montoCentavos })),
  );
}

export function calcularLibre(input: LibreInput): Libre {
  const { disponible, deuda, prestamos } = totales(input.saldos);

  const [p1, p2] = input.proximos;
  if (!p1) {
    return { disponible, deuda, prestamos, ingreso: null, dias: 0, tarjetas: [], recurrentes: [], gastoVariable: 0, libreHastaIngreso: null, despues: null };
  }

  const hasta = p1.fecha;
  // El día de hoy cuenta como pendiente: el ingreso aún no llegó.
  const desde = new Date(ms(input.hoy) - 86_400_000).toISOString().slice(0, 10);
  const tarjetas: Partida[] = input.tarjetas
    .filter(({ ciclo }) => ciclo.pendiente > 0 && ciclo.fechaPago <= hasta)
    .map(({ cuenta, ciclo }) => ({ concepto: cuenta.nombre, fecha: ciclo.fechaPago, montoCentavos: ciclo.pendiente }));
  const recurrentes = recurrentesEntre(input, desde, hasta);
  const dias = diasEntre(input.hoy, hasta);
  const gastoVariable = input.gastoDiarioCentavos * dias;
  const libreHastaIngreso = disponible - suma(tarjetas) - suma(recurrentes) - gastoVariable;

  let despues: Libre['despues'] = null;
  if (p2) {
    const proxTarjetas = input.tarjetas
      .filter(({ ciclo }) => ciclo.consumoPeriodo > 0)
      .map(({ cuenta, ciclo }) => ({ fecha: fechaPago(cuenta.credito!, ciclo.proximoCorte), monto: ciclo.consumoPeriodo }))
      .filter((t) => t.fecha > hasta && t.fecha <= p2.fecha)
      .reduce((a, t) => a + t.monto, 0);
    const obligaciones = proxTarjetas + suma(recurrentesEntre(input, hasta, p2.fecha)) + input.gastoDiarioCentavos * diasEntre(hasta, p2.fecha);
    despues = { hasta: p2.fecha, libre: libreHastaIngreso + p1.ingreso.montoCentavos - obligaciones };
  }

  return {
    disponible,
    deuda,
    prestamos,
    ingreso: { descripcion: p1.ingreso.descripcion, fecha: p1.fecha, montoCentavos: p1.ingreso.montoCentavos },
    dias,
    tarjetas,
    recurrentes,
    gastoVariable,
    libreHastaIngreso,
    despues,
  };
}

export function renderLibre(l: Libre, gastoDiarioCentavos: number): string {
  if (!l.ingreso || l.libreHastaIngreso === null) {
    return [
      `💵 Disponible hoy: <b>${formatCents(l.disponible)}</b>`,
      `💳 Deuda de tarjetas: ${formatCents(l.deuda)}`,
      ...(l.prestamos > 0 ? [`🧾 Préstamos: ${formatCents(l.prestamos)}`] : []),
      '',
      'Para calcular cuánto te queda libre necesito tus ingresos. Dímelo así: "me pagan Q8,000 el 15 y el último en mi BI débito".',
    ].join('\n');
  }
  const icono = l.libreHastaIngreso >= 0 ? '🟢' : '🔴';
  const detalle = (xs: ReadonlyArray<Partida>) => xs.map((x) => `${escapeHtml(x.concepto)} ${fecha(x.fecha)}`).join(', ');
  return [
    `${icono} <b>Libre hasta tu próximo ingreso</b>: <b>${formatCents(l.libreHastaIngreso)}</b>`,
    `<i>${escapeHtml(l.ingreso.descripcion)} el ${fecha(l.ingreso.fecha)} · en ${l.dias} día${l.dias === 1 ? '' : 's'}</i>`,
    '',
    `Disponible hoy: ${formatCents(l.disponible)}`,
    ...(l.tarjetas.length > 0 ? [`− Pagos de tarjeta: ${formatCents(suma(l.tarjetas))} (${detalle(l.tarjetas)})`] : []),
    ...(l.recurrentes.length > 0 ? [`− Recurrentes: ${formatCents(suma(l.recurrentes))} (${detalle(l.recurrentes)})`] : []),
    ...(l.gastoVariable > 0 ? [`− Día a día: ${formatCents(l.gastoVariable)} (${formatCents(gastoDiarioCentavos)} × ${l.dias} días)`] : []),
    ...(l.despues
      ? ['', `Después de ${escapeHtml(l.ingreso.descripcion)} (${formatCents(l.ingreso.montoCentavos)}): ~<b>${formatCents(l.despues.libre)}</b> libre hasta el ${fecha(l.despues.hasta)}`]
      : []),
    '',
    `💳 Deuda de tarjetas: ${formatCents(l.deuda)} (el crédito disponible no cuenta como libre)`,
    ...(l.prestamos > 0 ? [`🧾 Préstamos: ${formatCents(l.prestamos)}`] : []),
  ].join('\n');
}
