import { Output, generateText } from 'ai';
import type { z } from 'zod';
import { emojiMapFrom, resolveCategory } from '../categories';
import { normalizeParsedDate, todayGT, weekdayGT } from '../dates';
import { getOrSeedCategories } from '../dynamo';
import { logger } from '../logger';
import type { CategoryRecord, ParsedTransaction, Transaction } from '../types';
import { getAgentModel, getModel } from './llm';
import {
  ANSWER_SYSTEM_PROMPT,
  COACH_PAYDAY_SYSTEM_PROMPT,
  COACH_WEEKLY_SYSTEM_PROMPT,
  NARRATE_SYSTEM_PROMPT,
  buildCorrectSystemPrompt,
  buildParseSystemPrompt,
  buildReceiptSystemPrompt,
} from './prompts';
import type { PromptContext } from './prompts';
import { parseResultSchema, parsedTransactionSchema } from './schema';

// Topes TOTALES por llamada (incluyen los reintentos del SDK). Con la
// arquitectura asíncrona corren en el processor (120s): holgados a propósito.
const LLM_TIMEOUT_MS = 20_000;
const VISION_TIMEOUT_MS = 30_000;

/** Movimiento parseado con su fecha efectiva ya resuelta (retroactivas incluidas). */
export interface DatedTransaction extends ParsedTransaction {
  date: string;
}

export interface ParseOutcome {
  transactions: DatedTransaction[];
  clarification: string | null;
  noMovements: boolean;
  /** Pregunta financiera detectada ("¿cuánto tengo?"); el webhook la responde con datos. */
  question: string | null;
  /** Categorías que no existían y hay que persistir en la base de conocimientos. */
  createdCategories: Array<{ name: string; emoji: string }>;
  /** Mapa nombre→emoji del catálogo (incluidas las recién creadas), para denormalizar. */
  categoryEmoji: Map<string, string>;
}

async function loadPromptContext(): Promise<{ ctx: PromptContext; catalog: CategoryRecord[]; known: Map<string, CategoryRecord> }> {
  const catalog = await getOrSeedCategories();
  const known = new Map(catalog.map((c) => [c.name, c]));
  return {
    catalog,
    known,
    ctx: { categories: [...known.keys()], today: todayGT(), weekday: weekdayGT() },
  };
}

/** Resolución común post-LLM: categorías contra la base de conocimientos + fechas. */
function toOutcome(
  raw: z.infer<typeof parseResultSchema>,
  catalog: CategoryRecord[],
  known: Map<string, CategoryRecord>,
  today: string,
): ParseOutcome {
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
      return { ...t, category: resolved.name, date: normalizeParsedDate(t.date, today) };
    });

  return {
    transactions,
    clarification: raw.clarification,
    noMovements: raw.noMovements,
    question: raw.question,
    createdCategories,
    categoryEmoji,
  };
}

/**
 * Materializa transacciones ya extraídas (p.ej. por la herramienta del agente):
 * resuelve categorías contra la base de conocimientos y normaliza fechas.
 */
export async function materializeParsed(raw: {
  transactions: Array<z.infer<typeof parsedTransactionSchema>>;
  newCategories: Array<{ name: string; emoji: string }>;
}): Promise<ParseOutcome> {
  const { ctx, catalog, known } = await loadPromptContext();
  return toOutcome(
    { ...raw, clarification: null, noMovements: false, question: null },
    catalog,
    known,
    ctx.today,
  );
}

/** Convierte texto libre en transacciones estructuradas. Lanza si el proveedor falla. */
export async function parseTransactions(text: string): Promise<ParseOutcome> {
  const { ctx, catalog, known } = await loadPromptContext();

  const result = await generateText({
    model: getModel(),
    system: buildParseSystemPrompt(ctx),
    prompt: text,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    output: Output.object({ schema: parseResultSchema }),
  });

  const outcome = toOutcome(result.output, catalog, known, ctx.today);
  logger.info('parseo completado', {
    rawMessage: text,
    parsed: result.output,
    createdCategories: outcome.createdCategories,
  });
  return outcome;
}

/** Lee un comprobante (ticket/recibo/voucher) desde una imagen. */
export async function parseReceipt(
  image: Buffer,
  mediaType: string,
  caption: string | null,
): Promise<ParseOutcome> {
  const { ctx, catalog, known } = await loadPromptContext();

  const result = await generateText({
    model: getModel(),
    system: buildReceiptSystemPrompt(ctx),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', mediaType, data: image },
          {
            type: 'text',
            text: caption
              ? `Contexto del usuario sobre este comprobante: "${caption}"`
              : 'Extrae el movimiento de este comprobante.',
          },
        ],
      },
    ],
    temperature: 0,
    timeout: VISION_TIMEOUT_MS,
    output: Output.object({ schema: parseResultSchema }),
  });

  const outcome = toOutcome(result.output, catalog, known, ctx.today);
  logger.info('comprobante procesado', {
    caption,
    imageBytes: image.length,
    parsed: result.output,
    createdCategories: outcome.createdCategories,
  });
  return outcome;
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
  const { ctx, catalog, known } = await loadPromptContext();

  const { sk: _sk, emoji: _emoji, ...visible } = original;
  const prompt = [
    `Transacción registrada (JSON): ${JSON.stringify(visible)}`,
    `Mensaje original del usuario: "${original.rawMessage}"`,
    `Corrección solicitada: "${correctionText}"`,
  ].join('\n');

  const result = await generateText({
    model: getModel(),
    system: buildCorrectSystemPrompt(ctx),
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
  const emoji = resolved.created?.emoji ?? emojiMapFrom(catalog).get(resolved.name) ?? '🏷️';
  // La fecha no se corrige por esta vía: el SK del item la contiene (inmutable).
  const { date: _date, ...fields } = rawCorrected;
  const corrected: ParsedTransaction = { ...fields, category: resolved.name };

  logger.info('corrección completada', { original: visible, correctionText, corrected });
  return {
    corrected,
    emoji,
    ...(resolved.created ? { createdCategory: resolved.created } : {}),
  };
}

/** Responde una pregunta financiera usando ÚNICAMENTE el snapshot precalculado. */
export async function answerQuestion(question: string, snapshot: unknown): Promise<string> {
  const result = await generateText({
    model: getModel(),
    system: ANSWER_SYSTEM_PROMPT,
    prompt: `Pregunta: ${question}\n\nSnapshot: ${JSON.stringify(snapshot)}`,
    temperature: 0,
    timeout: LLM_TIMEOUT_MS,
    maxOutputTokens: 400,
  });
  return result.text.trim();
}

/**
 * Consejo del coach (semanal o de quincena) sobre insumos YA calculados en
 * código. Usa el modelo del agente: es donde la calidad del consejo importa.
 */
export async function coachNarrative(kind: 'weekly' | 'payday', input: unknown): Promise<string> {
  const result = await generateText({
    model: getAgentModel(),
    system: kind === 'weekly' ? COACH_WEEKLY_SYSTEM_PROMPT : COACH_PAYDAY_SYSTEM_PROMPT,
    prompt: JSON.stringify(input),
    timeout: 30_000,
    maxOutputTokens: 600,
  });
  return result.text.trim();
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
