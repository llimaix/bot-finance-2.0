import { Output, generateText } from 'ai';
import { logger } from '../logger';
import type { ParseResult, ParsedTransaction, Transaction } from '../types';
import { getModel } from './llm';
import { CORRECT_SYSTEM_PROMPT, NARRATE_SYSTEM_PROMPT, PARSE_SYSTEM_PROMPT } from './prompts';
import { parseResultSchema, parsedTransactionSchema } from './schema';

// Tope TOTAL de la llamada (incluye los reintentos del SDK): debe caber junto
// con la transcripción dentro de los 25s de la Lambda webhook, dejando margen
// para responder el ⚠️ si algo falla.
const LLM_TIMEOUT_MS = 12_000;

/** Convierte texto libre en transacciones estructuradas. Lanza si el proveedor falla. */
export async function parseTransactions(text: string): Promise<ParseResult> {
  const result = await generateText({
    model: getModel(),
    system: PARSE_SYSTEM_PROMPT,
    prompt: text,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    output: Output.object({ schema: parseResultSchema }),
  });

  const raw = result.output;
  // Los structured outputs no soportan `minimum`: el monto positivo se valida aquí.
  const transactions = raw.transactions.filter((t) => Number.isFinite(t.amount) && t.amount > 0);
  const dropped = raw.transactions.length - transactions.length;
  logger.info('parseo completado', { rawMessage: text, parsed: raw, dropped });
  return { transactions, clarification: raw.clarification, noMovements: raw.noMovements };
}

/** Regenera una transacción aplicando una corrección en lenguaje natural. */
export async function correctTransaction(
  original: Transaction,
  correctionText: string,
): Promise<ParsedTransaction> {
  const { sk: _sk, ...visible } = original;
  const prompt = [
    `Transacción registrada (JSON): ${JSON.stringify(visible)}`,
    `Mensaje original del usuario: "${original.rawMessage}"`,
    `Corrección solicitada: "${correctionText}"`,
  ].join('\n');

  const result = await generateText({
    model: getModel(),
    system: CORRECT_SYSTEM_PROMPT,
    prompt,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    output: Output.object({ schema: parsedTransactionSchema }),
  });

  const corrected = result.output;
  if (!Number.isFinite(corrected.amount) || corrected.amount <= 0) {
    throw new Error(`Corrección con monto inválido: ${corrected.amount}`);
  }
  logger.info('corrección completada', { original: visible, correctionText, corrected });
  return corrected;
}

/** Redacta el análisis del reporte a partir de agregados YA calculados en código. */
export async function narrateReport(aggregates: unknown): Promise<string> {
  const result = await generateText({
    model: getModel(),
    system: NARRATE_SYSTEM_PROMPT,
    prompt: JSON.stringify(aggregates),
    timeout: 30_000,
    maxOutputTokens: 1500,
  });
  return result.text.trim();
}
