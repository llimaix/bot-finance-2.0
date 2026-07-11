import { ulid } from 'ulid';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { correctTransaction, parseReceipt, parseTransactions } from '../lib/ai/parse';
import type { ParseOutcome } from '../lib/ai/parse';
import { HELP_TEXT, matchCommand, matchCorrection } from '../lib/commands';
import type { Command } from '../lib/commands';
import { config } from '../lib/config';
import { daysAgoGT, daysElapsedInMonthGT, monthLabelES, monthPrefixGT, todayGT } from '../lib/dates';
import {
  deleteTransaction,
  findByShortId,
  getTransaction,
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
  escapeHtml,
  renderConfirmation,
  renderDay,
  renderTxnLine,
  renderWeek,
  sumSpent,
  toCsv,
} from '../lib/format';
import { logger } from '../lib/logger';
import { buildReport } from '../lib/report';
import { getSttProvider } from '../lib/stt';
import { answerCallbackQuery, getFileBuffer, sendDocument, sendMessage } from '../lib/telegram';
import type {
  InlineKeyboardButton,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from '../lib/telegram';
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
  if (!update || typeof update.update_id !== 'number') return OK;
  const message = update.message;
  const callback = update.callback_query;
  if (!message && !callback) return OK;

  // 2. Idempotencia: Telegram reintenta updates; procesar cada update_id una sola vez
  if (!(await tryClaimUpdate(update.update_id))) {
    logger.info('update duplicado ignorado', { updateId: update.update_id });
    return OK;
  }

  // 3. Bot personal: cualquier otro chat/usuario se ignora en silencio
  const senderId = message?.chat.id ?? callback?.from.id;
  if (String(senderId) !== config.allowedChatId) {
    logger.warn('chat no permitido', { senderId });
    return OK;
  }

  try {
    if (callback) await handleCallback(callback);
    else if (message) await route(message);
  } catch (err) {
    logger.error('fallo procesando el update', {
      updateId: update.update_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await sendMessage(senderId!, ERROR_REPLY).catch((sendErr) =>
      logger.error('no se pudo enviar el mensaje de error', { error: String(sendErr) }),
    );
    if (callback) await answerCallbackQuery(callback.id).catch(() => undefined);
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

// ── Ruteo de mensajes ──────────────────────────────────────────────────────

async function route(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const today = todayGT();

  // Cualquier mensaje procesado cuenta como "ya respondió hoy" para el
  // recordatorio de seguimiento de las 21:00.
  await markReported(today);

  // Foto de ticket/comprobante (o imagen adjunta como documento)
  const photo = message.photo?.at(-1);
  const imageDoc = message.document?.mime_type?.startsWith('image/') ? message.document : undefined;
  if (photo || imageDoc) {
    const fileId = photo?.file_id ?? imageDoc!.file_id;
    const mediaType = imageDoc?.mime_type ?? 'image/jpeg';
    const image = await getFileBuffer(fileId);
    const outcome = await parseReceipt(image, mediaType, message.caption ?? null);
    await saveAndConfirm(chatId, today, outcome, message.caption ?? '(foto de comprobante)', {
      header: '🧾 Comprobante procesado',
      emptyReply:
        '🧾 No pude leer movimientos en la imagen. ¿Me cuentas el monto y qué fue en texto?',
    });
    return;
  }

  if (message.voice) {
    const audio = await getFileBuffer(message.voice.file_id);
    const transcript = await getSttProvider().transcribe(audio, message.voice.mime_type);
    const outcome = await parseTransactions(transcript);
    await saveAndConfirm(chatId, today, outcome, transcript, { transcript });
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(chatId, 'Solo entiendo texto, notas de voz o fotos de tickets 🙏');
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

  const outcome = await parseTransactions(text);
  await saveAndConfirm(chatId, today, outcome, text, {});
}

// ── Registro compartido (texto, voz y comprobantes) ────────────────────────

async function saveAndConfirm(
  chatId: number,
  today: string,
  outcome: ParseOutcome,
  rawMessage: string,
  opts: { transcript?: string; header?: string; emptyReply?: string },
): Promise<void> {
  const { transactions, clarification, noMovements, createdCategories, categoryEmoji } = outcome;

  // En respuestas de voz, mostrar siempre lo que se escuchó.
  const heard = opts.transcript ? `🎙️ Escuché: "${escapeHtml(opts.transcript)}"\n\n` : '';

  if (transactions.length === 0) {
    if (clarification) {
      await sendMessage(chatId, `${heard}❓ ${escapeHtml(clarification)}`);
    } else if (noMovements) {
      await sendMessage(chatId, `${heard}👍 Anotado: día sin movimientos.`);
    } else {
      await sendMessage(
        chatId,
        opts.emptyReply ??
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

  // Agrupar por fecha efectiva: los shortIds son por día ("ayer gasté..." reserva en ayer).
  const byDate = new Map<string, typeof transactions>();
  for (const t of transactions) {
    const group = byDate.get(t.date) ?? [];
    group.push(t);
    byDate.set(t.date, group);
  }

  const txns: Transaction[] = [];
  for (const [date, group] of byDate) {
    const shortIds = await markReportedAndReserveShortIds(date, group.length);
    group.forEach((t, i) => {
      txns.push({
        ...t,
        sk: `TXN#${date}#${ulid()}`,
        date,
        shortId: shortIds[i]!,
        rawMessage,
        createdAt,
        ...(categoryEmoji.has(t.category) ? { emoji: categoryEmoji.get(t.category)! } : {}),
      });
    });
  }
  await putTransactions(txns);

  const todayTxns = await queryDay(today);
  let reply = renderConfirmation({
    txns,
    today,
    totalSpentToday: sumSpent(todayTxns),
    clarification,
    ...(opts.transcript ? { transcript: opts.transcript } : {}),
    ...(opts.header ? { header: opts.header } : {}),
  });
  for (const cat of createdCategories) {
    reply += `\n🆕 Nueva categoría creada: ${cat.emoji} ${escapeHtml(cat.name)}`;
  }
  await sendMessage(chatId, reply, { keyboard: deleteKeyboard(txns) });
}

/** Botones 🗑️ por movimiento (callback_data del:<sk>, ≤64 bytes). */
function deleteKeyboard(txns: Transaction[]): InlineKeyboardButton[][] {
  const buttons = txns.map((t) => ({ text: `🗑️ #${t.shortId}`, callback_data: `del:${t.sk}` }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return rows;
}

// ── Botones inline ─────────────────────────────────────────────────────────

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const chatId = callback.from.id;
  const data = callback.data ?? '';

  if (data.startsWith('del:')) {
    const sk = data.slice(4);
    const txn = await getTransaction(sk);
    if (!txn) {
      await answerCallbackQuery(callback.id, 'Ese movimiento ya no existe');
      return;
    }
    await deleteTransaction(sk);
    await answerCallbackQuery(callback.id, 'Eliminado 🗑️');
    await sendMessage(chatId, `🗑️ Eliminado:\n${renderTxnLine(txn)}${txn.date !== todayGT() ? ` · 📅 ${txn.date}` : ''}`);
    return;
  }

  logger.warn('callback no reconocido', { data });
  await answerCallbackQuery(callback.id);
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

    case 'export': {
      const month = monthPrefixGT(0);
      const txns = await queryMonth(month);
      if (txns.length === 0) {
        await sendMessage(chatId, `📭 Sin movimientos en ${monthLabelES(month)} para exportar.`);
        return;
      }
      await sendDocument(
        chatId,
        `finanzas-${month}.csv`,
        toCsv(txns),
        `📤 ${txns.length} movimientos de ${monthLabelES(month)}`,
      );
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
