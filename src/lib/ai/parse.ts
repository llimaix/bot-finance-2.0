import { Output, generateText } from 'ai';
import { emojiMapFrom, resolveCategory } from '../categories';
import { getOrSeedCategories } from '../dynamo';
import { logger } from '../logger';
import type { ParsedTransaction, Transaction } from '../types';
import { getModel } from './llm';
import { NARRATE_SYSTEM_PROMPT, buildCorrectSystemPrompt, buildParseSystemPrompt } from './prompts';
import { parseResultSchema, parsedTransactionSchema } from './schema';

// Tope TOTAL de la llamada (incluye los reintentos del SDK): debe caber junto
// con la transcripción dentro de los 25s de la Lambda webhook, dejando margen
// para responder el ⚠️ si algo falla.
const LLM_TIMEOUT_MS = 12_000;

export interface ParseOutcome {
  transactions: ParsedTransaction[];
  clarification: string | null;
  noMovements: boolean;
  /** Categorías que no existían y hay que persistir en la base de conocimientos. */
  createdCategories: Array<{ name: string; emoji: string }>;
  /** Mapa nombre→emoji del catálogo (incluidas las recién creadas), para denormalizar. */
  categoryEmoji: Map<string, string>;
}

/** Convierte texto libre en transacciones estructuradas. Lanza si el proveedor falla. */
export async function parseTransactions(text: string): Promise<ParseOutcome> {
  const catalog = await getOrSeedCategories();
  const known = new Map(catalog.map((c) => [c.name, c]));

  const result = await generateText({
    model: getModel(),
    system: buildParseSystemPrompt([...known.keys()]),
    prompt: text,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    output: Output.object({ schema: parseResultSchema }),
  });

  const raw = result.output;
  const categoryEmoji = emojiMapFrom(catalog);
  const createdCategories: Array<{ name: string; emoji: string }> = [];

  const transactions = raw.transactions
    // Los structured outputs no soportan `minimum`: el monto positivo se valida aquí.
    .filter((t) => Number.isFinite(t.amount) && t.amount > 0)
    .map((t) => {
      const resolved = resolveCategory(t.category, known, raw.newCategories);
      if (resolved.created && !createdCategories.some((c) => c.name === resolved.created!.name)) {
        createdCategories.push(resolved.created);
        categoryEmoji.set(resolved.created.name, resolved.created.emoji);
      }
      return { ...t, category: resolved.name };
    });

  const dropped = raw.transactions.length - transactions.length;
  logger.info('parseo completado', { rawMessage: text, parsed: raw, dropped, createdCategories });
  return {
    transactions,
    clarification: raw.clarification,
    noMovements: raw.noMovements,
    createdCategories,
    categoryEmoji,
  };
}

export interface CorrectionOutcome {
  corrected: ParsedTransaction;
  emoji: string;
  /** Presente si la corrección requirió una categoría nueva. */
  createdCategory?: { name: string; emoji: string };
}

/** Regenera una transacción aplicando una corrección en lenguaje natural. */
export async function correctTransaction(
  original: Transaction,
  correctionText: string,
): Promise<CorrectionOutcome> {
  const catalog = await getOrSeedCategories();
  const known = new Map(catalog.map((c) => [c.name, c]));

  const { sk: _sk, emoji: _emoji, ...visible } = original;
  const prompt = [
    `Transacción registrada (JSON): ${JSON.stringify(visible)}`,
    `Mensaje original del usuario: "${original.rawMessage}"`,
    `Corrección solicitada: "${correctionText}"`,
  ].join('\n');

  const result = await generateText({
    model: getModel(),
    system: buildCorrectSystemPrompt([...known.keys()]),
    prompt,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    output: Output.object({ schema: parsedTransactionSchema }),
  });

  const rawCorrected = result.output;
  if (!Number.isFinite(rawCorrected.amount) || rawCorrected.amount <= 0) {
    throw new Error(`Corrección con monto inválido: ${rawCorrected.amount}`);
  }

  const resolved = resolveCategory(rawCorrected.category, known, []);
  const emoji =
    resolved.created?.emoji ?? emojiMapFrom(catalog).get(resolved.name) ?? '🏷️';
  const corrected = { ...rawCorrected, category: resolved.name };

  logger.info('corrección completada', { original: visible, correctionText, corrected });
  return {
    corrected,
    emoji,
    ...(resolved.created ? { createdCategory: resolved.created } : {}),
  };
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
