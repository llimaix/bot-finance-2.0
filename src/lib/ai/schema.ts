import { z } from 'zod';
import { METHODS, TXN_TYPES } from '../types';

/**
 * Única fuente de verdad para la forma del parseo. `type` y `method` siguen
 * siendo enums cerrados; `category` es ABIERTA: el catálogo vigente se inyecta
 * en el system prompt desde la base de conocimientos (DynamoDB) y el modelo
 * puede proponer categorías nuevas declarándolas en `newCategories`.
 *
 * Nota: los structured outputs no soportan `minimum`, así que `amount > 0`
 * se valida en código (parse.ts), no aquí.
 */
export const parsedTransactionSchema = z.object({
  amount: z.number(),
  type: z.enum(TXN_TYPES),
  category: z.string().min(1),
  method: z.enum(METHODS),
  description: z.string(),
  // yyyy-mm-dd cuando el mensaje/comprobante indica la fecha; null = hoy.
  // Se valida y acota en código (normalizeParsedDate).
  date: z.string().nullable(),
});

export const newCategorySchema = z.object({
  name: z.string().min(1),
  emoji: z.string(),
});

export const parseResultSchema = z.object({
  transactions: z.array(parsedTransactionSchema),
  clarification: z.string().nullable(),
  // Distingue "hoy no hubo movimientos" (explícito) de un mensaje que
  // simplemente no habla de dinero (saludo, pregunta, etc.).
  noMovements: z.boolean(),
  // Categorías que el modelo inventó para este mensaje (vacío normalmente).
  newCategories: z.array(newCategorySchema),
});
