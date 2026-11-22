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

/** Día de la semana de hoy en español ("viernes"), para orientar al parser. */
export function weekdayGT(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-GT', { weekday: 'long', timeZone: GT_TIMEZONE }).format(now);
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKDATE_DAYS = 366;

/**
 * Valida la fecha que devolvió el LLM para un movimiento retroactivo.
 * Reglas: formato yyyy-mm-dd real, sin futuro, máximo un año atrás.
 * Cualquier cosa inválida cae en hoy.
 */
export function normalizeParsedDate(raw: string | null | undefined, today: string): string {
  if (!raw || !ISO_DAY_RE.test(raw)) return today;
  if (raw > today) return today;
  const parsed = new Date(`${raw}T00:00:00Z`);
  // round-trip: descarta fechas imposibles tipo 2026-02-31
  if (parsed.toISOString().slice(0, 10) !== raw) return today;
  const floor = new Date(`${today}T00:00:00Z`).getTime() - MAX_BACKDATE_DAYS * MS_PER_DAY;
  if (parsed.getTime() < floor) return today;
  return raw;
}

// ── Calendario de pagos de Allan ────────────────────────────────────────────
// Regla real (2026-07-14): salario quincenal el 15 y el ÚLTIMO día del mes;
// si el día cae en fin de semana, se paga el último día HÁBIL anterior
// (15 en domingo → viernes 13; 31 en sábado → viernes 30).

/** Suma n días (puede ser negativo) a una fecha yyyy-mm-dd, aritmética pura. */
export function addDaysTo(date: string, n: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + n * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/** 0=domingo .. 6=sábado de una fecha yyyy-mm-dd (fecha pura, sin zona). */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Retrocede al último día hábil si la fecha cae en fin de semana. */
export function adjustToBusinessDay(date: string): string {
  const wd = weekdayOf(date);
  if (wd === 6) return addDaysTo(date, -1); // sábado → viernes
  if (wd === 0) return addDaysTo(date, -2); // domingo → viernes
  return date;
}

/** Los dos días de pago REALES de un mes yyyy-mm (quincena y fin de mes). */
export function paydaysOfMonth(yyyyMM: string): [string, string] {
  const last = String(daysInMonth(yyyyMM)).padStart(2, '0');
  return [adjustToBusinessDay(`${yyyyMM}-15`), adjustToBusinessDay(`${yyyyMM}-${last}`)];
}

/** El próximo día de pago ESTRICTAMENTE posterior a la fecha dada. */
export function nextPaydayAfter(date: string): string {
  const candidates = [...paydaysOfMonth(date.slice(0, 7)), ...paydaysOfMonth(nextMonthOf(date.slice(0, 7)))];
  return candidates.find((d) => d > date)!;
}

function nextMonthOf(yyyyMM: string): string {
  const [y, m] = yyyyMM.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(y, m, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Etiqueta legible en español para un mes yyyy-mm, p.ej. "junio de 2026". */
export function monthLabelES(yyyyMM: string): string {
  const [y, m] = yyyyMM.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('es-GT', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}
