type Level = 'info' | 'warn' | 'error';

/**
 * Claves que llevan texto o montos del usuario: mensajes, respuestas del
 * agente, movimientos parseados, transcripciones, hechos aprendidos (salario,
 * deudas), saldos y metas. Se registra su tipo y longitud, nunca el valor:
 * los logs sirven para diagnosticar, no para guardar las finanzas de nadie.
 */
const SENSITIVE_KEYS = new Set([
  'userText',
  'reply',
  'rawMessage',
  'parsed',
  'caption',
  'original',
  'correctionText',
  'corrected',
  'corrections',
  'text',
  'clarification',
  'amount',
  'seedBalance',
  'monthlyLimit',
]);

function summarize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return `[redactado: ${value.length} car.]`;
  if (Array.isArray(value)) return `[redactado: ${value.length} elementos]`;
  return `[redactado: ${typeof value}]`;
}

/** Sustituye por un resumen los valores de las claves sensibles (primer nivel). */
export function redact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, SENSITIVE_KEYS.has(key) ? summarize(value) : value]),
  );
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...(data ? redact(data) : {}) }));
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};
