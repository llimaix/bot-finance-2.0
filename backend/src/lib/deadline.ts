/**
 * Presupuesto de tiempo de la invocación en curso (M5).
 *
 * El handler del processor fija el límite a partir de
 * context.getRemainingTimeInMillis() y las fases largas (agente, reintento,
 * red de seguridad) ajustan su timeout o se omiten para terminar ANTES de que
 * Lambda corte: si corta, el catch no corre y el mensaje se pierde.
 *
 * Estado de módulo a propósito: Lambda procesa UN evento por contenedor a la
 * vez, así que no hay invocaciones concurrentes que lo compartan. Sin límite
 * fijado (tests, eval, scripts locales) el tiempo es ilimitado.
 */
let deadlineAt: number | undefined;

/** Fija (o quita, con undefined) el instante límite en ms epoch. */
export function setDeadline(at: number | undefined): void {
  deadlineAt = at;
}

/** Milisegundos que quedan hasta el límite (Infinity si no hay límite). */
export function remainingMs(now: number = Date.now()): number {
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - now);
}

/** Timeout a conceder a una operación que querría `wantedMs`: lo que pide, sin pasar del límite. */
export function budgetMs(wantedMs: number, now: number = Date.now()): number {
  return Math.min(wantedMs, remainingMs(now));
}

/** ¿Cabe una operación de `neededMs` antes del límite? */
export function fits(neededMs: number, now: number = Date.now()): boolean {
  return remainingMs(now) >= neededMs;
}
