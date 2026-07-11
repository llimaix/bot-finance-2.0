import { ulid } from 'ulid';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { correctTransaction, parseTransactions } from '../lib/ai/parse';
import { HELP_TEXT, matchCommand, matchCorrection } from '../lib/commands';
import type { Command } from '../lib/commands';
import { config } from '../lib/config';
import { daysAgoGT, daysElapsedInMonthGT, monthLabelES, monthPrefixGT, todayGT } from '../lib/dates';
import {
  deleteTransaction,
  findByShortId,
  listCategories,
  markReported,
  markReportedAndReserveShortIds,
  putCategoryIfAbsent,
  putTransactions,
  queryDay,
  queryMonth,
  queryRange,
  tryClaimUpdate,
  updateTransactionFields,
} from '../lib/dynamo';
import {
  emojiForCategory,
  escapeHtml,
  formatQ,
  renderConfirmation,
  renderDay,
  renderTxnLine,
  sumSpent,
} from '../lib/format';
import { computeAggregates } from '../lib/aggregates';
import { logger } from '../lib/logger';
import { buildReport } from '../lib/report';
import { getSttProvider } from '../lib/stt';
import { getFileBuffer, sendMessage } from '../lib/telegram';
import type { TelegramMessage, TelegramUpdate } from '../lib/telegram';
import type { Transaction } from '../lib/types';

const OK: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: 'ok' };

const ERROR_REPLY = '⚠️ No pude procesar esto, intenta de nuevo o escríbelo como texto.';

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  // 1. Secret token del webhook (los headers llegan en minúsculas en HTTP API v2)
  if (event.headers['x-telegram-bot-api-secret-token'] !== config.telegramWebhookSecret) {
    logger.warn('secret token inválido');
    return { statusCode: 401, body: 'unauthorized' };
  }

  const update = parseUpdate(event.body);
  const message = update?.message;
  if (!update || typeof update.update_id !== 'number' || !message) return OK;

  // 2. Idempotencia: Telegram reintenta updates; procesar cada update_id una sola vez
  if (!(await tryClaimUpdate(update.update_id))) {
    logger.info('update duplicado ignorado', { updateId: update.update_id });
    return OK;
  }

  // 3. Bot personal: cualquier otro chat se ignora en silencio
  const chatId = message.chat.id;
  if (String(chatId) !== config.allowedChatId) {
    logger.warn('chat no permitido', { chatId });
    return OK;
  }

  try {
    await route(message);
  } catch (err) {
    logger.error('fallo procesando el mensaje', {
      updateId: update.update_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await sendMessage(chatId, ERROR_REPLY).catch((sendErr) =>
      logger.error('no se pudo enviar el mensaje de error', { error: String(sendErr) }),
    );
  }

  // 4. Siempre 200 después de reclamar el update: un non-2xx haría que Telegram
  //    reenvíe un update envenenado para siempre.
  return OK;
};

function parseUpdate(body: string | undefined): TelegramUpdate | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as TelegramUpdate;
  } catch {
    logger.warn('body no es JSON válido');
    return null;
  }
}

async function route(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const today = todayGT();

  // Cualquier mensaje procesado cuenta como "ya respondió hoy" para el
  // recordatorio de seguimiento de las 21:00.
  await markReported(today);

  if (message.voice) {
    const audio = await getFileBuffer(message.voice.file_id);
    const transcript = await getSttProvider().transcribe(audio, message.voice.mime_type);
    await handleFreeText(chatId, today, transcript, transcript);
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(chatId, 'Solo entiendo texto o notas de voz 🙏');
    return;
  }

  const command = matchCommand(text);
  if (command) {
    await handleCommand(chatId, today, command);
    return;
  }

  const correction = matchCorrection(text);
  if (correction) {
    await handleCorrection(chatId, today, correction.shortId, correction.text);
    return;
  }

  await handleFreeText(chatId, today, text);
}

// ── Registro de movimientos ────────────────────────────────────────────────

async function handleFreeText(
  chatId: number,
  today: string,
  text: string,
  transcript?: string,
): Promise<void> {
  const { transactions, clarification, noMovements, createdCategories, categoryEmoji } =
    await parseTransactions(text);

  // En respuestas de voz, mostrar siempre lo que se escuchó.
  const heard = transcript ? `🎙️ Escuché: "${escapeHtml(transcript)}"\n\n` : '';

  if (transactions.length === 0) {
    if (clarification) {
      await sendMessage(chatId, `${heard}❓ ${escapeHtml(clarification)}`);
    } else if (noMovements) {
      await sendMessage(chatId, `${heard}👍 Anotado: día sin movimientos.`);
    } else {
      // Saludo o mensaje que no habla de dinero: no registrar nada.
      await sendMessage(
        chatId,
        `${heard}👋 ¡Hola! No identifiqué movimientos en tu mensaje. Cuéntame tus gastos o ingresos del día, o dime "hoy nada" si no hubo.`,
      );
    }
    return;
  }

  // Persistir primero las categorías nuevas: la base de conocimientos crece sola.
  const createdAt = new Date().toISOString();
  for (const cat of createdCategories) {
    await putCategoryIfAbsent({ ...cat, source: 'auto', createdAt });
  }

  const shortIds = await markReportedAndReserveShortIds(today, transactions.length);
  const txns: Transaction[] = transactions.map((t, i) => ({
    ...t,
    sk: `TXN#${today}#${ulid()}`,
    date: today,
    shortId: shortIds[i]!,
    rawMessage: text,
    createdAt,
    ...(categoryEmoji.has(t.category) ? { emoji: categoryEmoji.get(t.category)! } : {}),
  }));
  await putTransactions(txns);

  const todayTxns = await queryDay(today);
  let reply = renderConfirmation({
    txns,
    totalSpentToday: sumSpent(todayTxns),
    clarification,
    ...(transcript ? { transcript } : {}),
  });
  for (const cat of createdCategories) {
    reply += `\n🆕 Nueva categoría creada: ${cat.emoji} ${escapeHtml(cat.name)}`;
  }
  await sendMessage(chatId, reply);
}

// ── Comandos ───────────────────────────────────────────────────────────────

async function handleCommand(chatId: number, today: string, command: Command): Promise<void> {
  switch (command.kind) {
    case 'ayuda':
      await sendMessage(chatId, HELP_TEXT);
      return;

    case 'nada':
      // El día ya quedó marcado como reportado en route(); atajo sin pasar por el LLM.
      await sendMessage(chatId, '👍 Anotado: día sin movimientos.');
      return;

    case 'categorias': {
      const cats = await listCategories();
      if (cats.length === 0) {
        await sendMessage(chatId, '🏷️ Aún no hay categorías: se siembran con tu primer movimiento.');
        return;
      }
      const auto = cats.filter((c) => c.source === 'auto');
      const lines = [
        `🏷️ <b>Base de conocimientos</b> (${cats.length} categorías):`,
        '',
        ...cats
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `${c.emoji} ${escapeHtml(c.name)}${c.source === 'auto' ? ' · creada por el bot' : ''}`),
      ];
      if (auto.length === 0) {
        lines.push('', 'Cuando un movimiento no encaje en ninguna, crearé una nueva automáticamente.');
      }
      await sendMessage(chatId, lines.join('\n'));
      return;
    }

    case 'hoy': {
      const txns = await queryDay(today);
      await sendMessage(chatId, renderDay(today, txns));
      return;
    }

    case 'semana': {
      const txns = await queryRange(daysAgoGT(6), today);
      await sendMessage(chatId, renderWeek(txns));
      return;
    }

    case 'mes': {
      const month = monthPrefixGT(0);
      const txns = await queryMonth(month);
      const report = await buildReport({
        periodLabel: `${monthLabelES(month)} (al día ${daysElapsedInMonthGT()})`,
        txns,
        prevTxns: [],
        daysInPeriod: daysElapsedInMonthGT(),
        includeNarrative: false,
      });
      await sendMessage(chatId, report);
      return;
    }

    case 'reporte': {
      const month = monthPrefixGT(0);
      const [txns, prevTxns] = await Promise.all([queryMonth(month), queryMonth(monthPrefixGT(-1))]);
      const report = await buildReport({
        periodLabel: `${monthLabelES(month)} (al día ${daysElapsedInMonthGT()})`,
        txns,
        prevTxns,
        daysInPeriod: daysElapsedInMonthGT(),
        includeNarrative: true,
      });
      await sendMessage(chatId, report);
      return;
    }

    case 'borrar': {
      if (command.shortId === null) {
        await sendMessage(chatId, 'Uso: /borrar N — donde N es el número del movimiento de hoy (míralo con /hoy).');
        return;
      }
      const txn = await findByShortId(today, command.shortId);
      if (!txn) {
        await sendMessage(chatId, `No encontré el movimiento #${command.shortId} de hoy.`);
        return;
      }
      await deleteTransaction(txn.sk);
      await sendMessage(chatId, `🗑️ Eliminado:\n${renderTxnLine(txn)}`);
      return;
    }
  }
}

/** Resumen de los últimos 7 días por categoría. */
function renderWeek(txns: Transaction[]): string {
  if (txns.length === 0) return '📭 Sin movimientos en los últimos 7 días.';
  const agg = computeAggregates(txns, 7);
  const lines = ['📅 <b>Últimos 7 días</b>', '', `💸 Gastos: ${formatQ(agg.totalGastos)}`, `📈 Promedio diario: ${formatQ(agg.dailyAverage)}`, ''];
  const cats = Object.entries(agg.byCategory).sort(([, a], [, b]) => b.sum - a.sum);
  for (const [cat, data] of cats) {
    lines.push(`${emojiForCategory(cat, txns)} ${cat}: ${formatQ(data.sum)} (${data.count})`);
  }
  return lines.join('\n');
}

// ── Correcciones "corrige #N ..." ─────────────────────────────────────────

async function handleCorrection(
  chatId: number,
  today: string,
  shortId: number,
  correctionText: string,
): Promise<void> {
  const original = await findByShortId(today, shortId);
  if (!original) {
    await sendMessage(chatId, `No encontré el movimiento #${shortId} de hoy.`);
    return;
  }

  const { corrected, emoji, createdCategory } = await correctTransaction(original, correctionText);
  if (createdCategory) {
    await putCategoryIfAbsent({ ...createdCategory, source: 'auto', createdAt: new Date().toISOString() });
  }
  await updateTransactionFields(original.sk, { ...corrected, emoji });

  const after: Transaction = { ...original, ...corrected, emoji };
  const lines = [`✏️ Corregido #${shortId}:`, `Antes: ${renderTxnLine(original)}`, `Ahora: ${renderTxnLine(after)}`];
  if (createdCategory) {
    lines.push(`🆕 Nueva categoría creada: ${createdCategory.emoji} ${escapeHtml(createdCategory.name)}`);
  }
  await sendMessage(chatId, lines.join('\n'));
}
