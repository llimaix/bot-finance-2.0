import { z } from 'zod';
import { CATEGORIES, METHODS, TXN_TYPES } from '../types';

/**
 * Única fuente de verdad para la forma del parseo: los enums vienen de los
 * arrays `as const` de types.ts, así que tipos TS y validación nunca divergen.
 *
 * Nota: los structured outputs de los proveedores no soportan `minimum`, así
 * que `amount > 0` se valida en código (parse.ts), no aquí.
 */
export const parsedTransactionSchema = z.object({
  amount: z.number(),
  type: z.enum(TXN_TYPES),
  category: z.enum(CATEGORIES),
  method: z.enum(METHODS),
  description: z.string(),
});

export const parseResultSchema = z.object({
  transactions: z.array(parsedTransactionSchema),
  clarification: z.string().nullable(),
  // Distingue "hoy no hubo movimientos" (explícito) de un mensaje que
  // simplemente no habla de dinero (saludo, pregunta, etc.).
  noMovements: z.boolean(),
});
