/**
 * Dinero en centavos enteros (modelo v2): sin punto flotante en saldos ni sumas.
 * 0,10 + 0,20 da exactamente 30 centavos.
 */

/** Quetzales (número) → centavos enteros. Lanza si no es finito. */
export function toCents(quetzales: number): number {
  if (!Number.isFinite(quetzales)) throw new Error(`Monto no finito: ${quetzales}`);
  // EPSILON corrige representaciones binarias como 1.005 → 100.4999…
  return Math.round((quetzales + Math.sign(quetzales) * Number.EPSILON) * 100);
}

/** Centavos → quetzales (solo para mostrar o para APIs que esperan decimales). */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Centavos → "Q1,234.56" (negativo: "-Q50.00"). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}Q${whole}.${frac}`;
}

/** Monto válido para un movimiento: entero de centavos mayor que 0. */
export function isValidAmountCents(cents: number): boolean {
  return Number.isInteger(cents) && cents > 0;
}
