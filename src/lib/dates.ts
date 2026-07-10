/**
 * Fechas en hora de Guatemala (UTC-6, sin horario de verano).
 *
 * `TZ` es una env var reservada en Lambda, así que todo pasa por Intl con
 * timeZone explícito. Como GT no tiene DST, la aritmética por epoch es segura.
 */
const GT_TIMEZONE = 'America/Guatemala';

// en-CA produce yyyy-mm-dd
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: GT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MS_PER_DAY = 86_400_000;

/** Fecha de hoy en Guatemala, formato yyyy-mm-dd. */
export function todayGT(now: Date = new Date()): string {
  return dayFormatter.format(now);
}

/** Fecha de hace `n` días en Guatemala, formato yyyy-mm-dd. */
export function daysAgoGT(n: number, now: Date = new Date()): string {
  return dayFormatter.format(new Date(now.getTime() - n * MS_PER_DAY));
}

/** Prefijo de mes yyyy-mm, con desplazamiento en meses (0 = mes en curso, -1 = anterior). */
export function monthPrefixGT(offsetMonths = 0, now: Date = new Date()): string {
  const [y, m] = todayGT(now).split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1 + offsetMonths, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Días transcurridos del mes en curso (incluye hoy). */
export function daysElapsedInMonthGT(now: Date = new Date()): number {
  return Number(todayGT(now).slice(8, 10));
}

/** Cantidad de días de un mes yyyy-mm. */
export function daysInMonth(yyyyMM: string): number {
  const [y, m] = yyyyMM.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Etiqueta legible en español para un mes yyyy-mm, p.ej. "junio de 2026". */
export function monthLabelES(yyyyMM: string): string {
  const [y, m] = yyyyMM.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('es-GT', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}
