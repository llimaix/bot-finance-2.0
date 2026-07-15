import { generateText, tool } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import type { z } from 'zod';
import { emojiMapFrom, resolveCategory } from '../categories';
import { config } from '../config';
import { toQuetzales } from '../currency';
import { normalizeParsedDate, todayGT, weekdayGT } from '../dates';
import { getOrSeedCategories } from '../dynamo';
import { logger } from '../logger';
import type { CategoryRecord, ParsedTransaction, Transaction } from '../types';
import { getAgentModel, getModel, getVisionModel, logUsage, stripThinking } from './llm';
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
// arquitectura asíncrona corren en el processor (180s): holgados a propósito.
// Visión: MiniMax-M3 razona largo sobre imágenes — el tope de 30s cortó el
// primer comprobante en producción (14-jul, 32.8s).
const LLM_TIMEOUT_MS = 30_000;
const VISION_TIMEOUT_MS = 75_000;

/**
 * Extracción estructurada vía TOOL CALL forzado — el mecanismo más portable
 * entre proveedores. Output.object (JSON en modo texto) se rompe con los
 * modelos razonadores servidos por API OpenAI-compatible: MiniMax-M3 envuelve
 * el JSON en <think> y el parser del SDK no lo encuentra (incidente 14-jul);
 * los tool calls nativos llegan como JSON limpio y validado contra el schema.
 */
async function extractWithTool<SCHEMA extends z.ZodType>(opts: {
  fn: string;
  model: LanguageModel;
  modelId: string;
  system: string;
  schema: SCHEMA;
  timeout: number;
  prompt?: string;
  messages?: ModelMessage[];
}): Promise<z.infer<SCHEMA>> {
  const result = await generateText({
    model: opts.model,
    system: opts.system,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : { messages: opts.messages! }),
    tools: {
      entregar_resultado: tool({
        description: 'Entrega el resultado estructurado. Llámala SIEMPRE, exactamente una vez.',
        inputSchema: opts.schema,
      }),
    },
    toolChoice: 'required',
    temperature: 0,
    timeout: opts.timeout,
  });
  logUsage(opts.fn, opts.modelId, result.usage);
  const input = result.toolCalls.at(-1)?.input;
  if (input === undefined) {
    throw new Error(`El modelo no entregó el resultado estructurado (${opts.fn})`);
  }
  return input as z.infer<SCHEMA>;
}

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
    .map((raw_t) => {
      // USD → Q en código, con la convención de la ingesta en la descripción.
      const t = toQuetzales(raw_t, config.usdGtqRate);
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

  const raw = await extractWithTool({
    fn: 'parseTransactions',
    model: getModel(),
    modelId: config.llmModel,
    system: buildParseSystemPrompt(ctx),
    prompt: text,
    schema: parseResultSchema,
    timeout: LLM_TIMEOUT_MS,
  });

  const outcome = toOutcome(raw, catalog, known, ctx.today);
  logger.info('parseo completado', {
    rawMessage: text,
    parsed: raw,
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

  const raw = await extractWithTool({
    fn: 'parseReceipt',
    // Modelo de VISIÓN: separable del principal por si el de texto no ve imágenes.
    model: getVisionModel(),
    modelId: config.llmModelVision,
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
    schema: parseResultSchema,
    timeout: VISION_TIMEOUT_MS,
  });

  const outcome = toOutcome(raw, catalog, known, ctx.today);
  logger.info('comprobante procesado', {
    caption,
    imageBytes: image.length,
    parsed: raw,
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

  const output = await extractWithTool({
    fn: 'correctTransaction',
    model: getModel(),
    modelId: config.llmModel,
    system: buildCorrectSystemPrompt(ctx),
    prompt,
    schema: parsedTransactionSchema,
    timeout: LLM_TIMEOUT_MS,
  });

  // USD → Q en código ("el monto es en dólares" convierte, no solo renombra).
  const rawCorrected = toQuetzales(output, config.usdGtqRate);
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
  logUsage('answerQuestion', config.llmModel, result.usage);
  return stripThinking(result.text);
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
  logUsage(`coach:${kind}`, config.llmModelAgent, result.usage);
  return stripThinking(result.text);
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
  logUsage('narrateReport', config.llmModel, result.usage);
  return stripThinking(result.text);
}
