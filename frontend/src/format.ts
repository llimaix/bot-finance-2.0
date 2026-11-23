const money = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ', minimumFractionDigits: 2 });
const moneyRound = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ', maximumFractionDigits: 0 });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Centavos → "Q1,234.56". */
export const q = (cents: number): string => money.format(cents / 100);
/** Centavos → "Q1,235" (cifras grandes). */
export const q0 = (cents: number): string => moneyRound.format(cents / 100);

/** Centavos → "Q1.2k" para ejes. */
export function qCompact(cents: number): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `Q${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `Q${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `Q${Math.round(v)}`;
}

/** "2026-11-13" → "13 nov". */
export const fecha = (iso: string): string => `${Number(iso.slice(8, 10))} ${MESES[Number(iso.slice(5, 7)) - 1]}`;

/** "2026-11" → "noviembre". */
export const mesLargo = (yyyyMM: string): string =>
  new Date(`${yyyyMM}-15T12:00:00Z`).toLocaleDateString('es-GT', { month: 'long', timeZone: 'UTC' });

export const pct = (n: number): string => `${Math.round(n)}%`;

export const capitalizar = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const plural = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;
