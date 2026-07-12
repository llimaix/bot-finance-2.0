import { ulid } from 'ulid';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { runAgent } from '../lib/ai/agent';
import type { AgentDeps } from '../lib/ai/agent';
import { answerQuestion, correctTransaction, materializeParsed, parseReceipt } from '../lib/ai/parse';
import type { ParseOutcome } from '../lib/ai/parse';
import { DEFAULT_ACCOUNTS, computeBalances, renderSaldos } from '../lib/accounts';
import { computeAggregates } from '../lib/aggregates';
import { registrationWarnings } from '../lib/guards';
import { loadAdvisorData, loadBalancesReadonly, renderProjection } from '../lib/insights';
import { detectRecurring, findNewCandidates } from '../lib/recurring';
import { summarizeSearch } from '../lib/search';
import type { RecurringPayment } from '../lib/recurring';
import { HELP_TEXT, matchCommand, matchCorrection } from '../lib/commands';
import type { Command } from '../lib/commands';
import { config } from '../lib/config';
import { daysAgoGT, daysElapsedInMonthGT, daysInMonth, monthLabelES, monthPrefixGT, todayGT } from '../lib/dates';
import {
  appendConversation,
  deleteFact,
  deleteTransaction,
  findByShortId,
  getConversation,
  getOrSeedAccounts,
  getTransaction,
  listCategories,
  listFacts,
  listRecurring,
  putFact,
  markReported,
  markReportedAndReserveShortIds,
  putAccount,
  putCategoryIfAbsent,
  putRecurring,
  putTransactions,
  queryDay,
  queryMonth,
  queryRange,
  tryClaimUpdate,
  updateTransactionFields,
} from '../lib/dynamo';
import {
  escapeHtml,
  formatQ,
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
import { answerCallbackQuery, getFileBuffer, sendDocument, sendMessage, sendTyping } from '../lib/telegram';
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
    await agentFlow(chatId, today, transcript, transcript);
    return;
  }

  const text = message.text?.trim();
  if (!text) {
    await sendMessage(chatId, 'Solo entiendo texto, notas de voz o fotos de tickets 🙏');
    return;
  }

  // Rutas rápidas deterministas (sin LLM): comandos y "corrige #N"
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

  await agentFlow(chatId, today, text);
}

// ── Agente conversacional (texto y voz) ────────────────────────────────────

async function agentFlow(chatId: number, today: string, userText: string, transcript?: string): Promise<void> {
  await sendTyping(chatId);
  const [history, balances, cats, facts] = await Promise.all([
    getConversation(),
    loadBalances(today),
    listCategories(),
    listFacts(),
  ]);

  const contextInfo = [
    `Cuentas (saldo actual): ${balances
      .map((b) => `${b.name} [id:${b.id}]: ${formatQ(b.balance)}${b.estimated ? ' (estimado)' : ''}`)
      .join('; ')}.`,
    `Catálogo de categorías: ${cats.map((c) => c.name).join(', ')}.`,
    ...(facts.length > 0
      ? [`Hechos que Allan te ha enseñado:\n${facts.map((f) => `- ${f.text}`).join('\n')}`]
      : []),
  ].join('\n');

  const collectedWarnings: string[] = [];
  const deps: AgentDeps = {
    today,
    contextInfo,
    register: async (input) => {
      const outcome = await materializeParsed(input);
      const txns = await persistOutcome(outcome, userText, today);
      const [todayTxns, advertencias] = await Promise.all([queryDay(today), warningsFor(txns)]);
      collectedWarnings.push(...advertencias);
      return {
        txns,
        createdCategories: outcome.createdCategories,
        totalSpentToday: sumSpent(todayTxns),
        advertencias,
      };
    },
    snapshot: () => buildSnapshot(today),
    adjustAccount: async ({ cuenta, nuevoSaldo, nuevoNombre }) => {
      const accounts = await getOrSeedAccounts(today);
      const base =
        accounts.find((a) => a.id === cuenta) ??
        ({ ...DEFAULT_ACCOUNTS.find((d) => d.id === cuenta)!, seedBalance: 0, asOf: today, estimated: true, updatedAt: '' });
      let saldo = nuevoSaldo ?? base.seedBalance;
      if (cuenta === 'tarjeta' && nuevoSaldo !== null && nuevoSaldo > 0) saldo = -nuevoSaldo;
      await putAccount({
        ...base,
        name: nuevoNombre?.trim() || base.name,
        seedBalance: saldo,
        asOf: nuevoSaldo !== null ? today : base.asOf,
        estimated: nuevoSaldo !== null ? false : base.estimated,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true, cuenta: nuevoNombre?.trim() || base.name, saldoAlCierreDeHoy: saldo };
    },
    markNoMovements: async () => {
      await markReported(today);
    },
    rememberFact: async (dato) => {
      await putFact({ id: ulid(), text: dato.trim(), createdAt: new Date().toISOString() });
      return { ok: true, aprendido: dato.trim() };
    },
    searchMovements: async ({ desde, hasta, categoria, texto }) => {
      // acotar el rango para no barrer la tabla completa
      const from = desde <= hasta ? desde : hasta;
      const to = desde <= hasta ? hasta : desde;
      const txns = await queryRange(from, to);
      return { rango: { desde: from, hasta: to }, ...summarizeSearch(txns, { categoria, texto }) };
    },
  };

  // Presupuesto: la voz ya gastó ~8s transcribiendo; el texto tiene más margen.
  const result = await runAgent(userText, history, deps, { timeoutMs: transcript ? 13_000 : 20_000 });

  const heard = transcript ? `🎙️ Escuché: "${escapeHtml(transcript)}"\n\n` : '';
  let reply = `${heard}${escapeHtml(result.text)}`;
  if (result.registered.length > 0) {
    reply += `\n\n${result.registered
      .map((t) => `${renderTxnLine(t)}${t.date !== today ? ` · 📅 ${t.date}` : ''}`)
      .join('\n')}`;
  }
  for (const warning of collectedWarnings) {
    reply += `\n${escapeHtml(warning)}`;
  }
  await sendMessage(
    chatId,
    reply,
    result.registered.length > 0 ? { keyboard: deleteKeyboard(result.registered) } : undefined,
  );

  await appendConversation([
    { role: 'user', text: userText, at: new Date().toISOString() },
    { role: 'assistant', text: result.text, at: new Date().toISOString() },
  ]).catch((err) => logger.error('no se pudo guardar la conversación', { error: String(err) }));

  if (result.registered.length > 0) {
    await askAboutNewRecurring(chatId).catch((err) =>
      logger.error('detección de recurrentes falló', { error: String(err) }),
    );
  }
}

// ── Registro compartido (texto, voz y comprobantes) ────────────────────────

async function saveAndConfirm(
  chatId: number,
  today: string,
  outcome: ParseOutcome,
  rawMessage: string,
  opts: { transcript?: string; header?: string; emptyReply?: string },
): Promise<void> {
  const { transactions, clarification, noMovements, question, createdCategories, categoryEmoji } = outcome;

  // En respuestas de voz, mostrar siempre lo que se escuchó.
  const heard = opts.transcript ? `🎙️ Escuché: "${escapeHtml(opts.transcript)}"\n\n` : '';

  if (transactions.length === 0) {
    if (question) {
      const answer = await answerQuestion(question, await buildSnapshot(today));
      await sendMessage(chatId, `${heard}${escapeHtml(answer)}`);
      return;
    }
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

  const txns = await persistOutcome(outcome, rawMessage, today);

  const [todayTxns, warnings] = await Promise.all([queryDay(today), warningsFor(txns)]);
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
  for (const warning of warnings) {
    reply += `\n${escapeHtml(warning)}`;
  }
  await sendMessage(chatId, reply, { keyboard: deleteKeyboard(txns) });

  // Aprendizaje: si aparecieron posibles recurrentes nuevos, preguntar.
  await askAboutNewRecurring(chatId).catch((err) =>
    logger.error('detección de recurrentes falló', { error: String(err) }),
  );
}

// ── Aprendizaje de gastos recurrentes ──────────────────────────────────────

const MAX_RECURRING_QUESTIONS = 2;

/**
 * Detecta candidatos a recurrente que aún no están en la base de conocimientos
 * y se los pregunta al usuario con botones. La respuesta queda aprendida:
 * confirmados alimentan al asesor, rechazados no se vuelven a preguntar.
 */
async function askAboutNewRecurring(chatId: number): Promise<void> {
  const [monthTxns, prevTxns, prev2Txns, known] = await Promise.all([
    queryMonth(monthPrefixGT(0)),
    queryMonth(monthPrefixGT(-1)),
    queryMonth(monthPrefixGT(-2)),
    listRecurring(),
  ]);
  const detected = detectRecurring([...prev2Txns, ...prevTxns, ...monthTxns], {
    types: ['gasto', 'ingreso'],
  });
  const candidates = findNewCandidates(detected, known).slice(0, MAX_RECURRING_QUESTIONS);

  const now = new Date().toISOString();
  for (const candidate of candidates) {
    // Se guarda como candidate ANTES de preguntar: no volver a preguntar aunque no responda.
    await putRecurring({
      slug: candidate.slug,
      descripcion: candidate.descripcion,
      categoria: candidate.categoria,
      tipo: candidate.tipo,
      montoTipico: candidate.montoTipico,
      diaTipico: candidate.diaTipico,
      status: 'candidate',
      source: 'auto',
      createdAt: now,
      updatedAt: now,
    });
    await sendRecurringQuestion(chatId, candidate);
  }
}

async function sendRecurringQuestion(chatId: number, candidate: RecurringPayment): Promise<void> {
  const esIngreso = candidate.tipo === 'ingreso';
  await sendMessage(
    chatId,
    [
      esIngreso ? '🔁 Detecté un posible INGRESO recurrente:' : '🔁 Detecté un posible gasto recurrente:',
      `<b>${escapeHtml(candidate.descripcion)}</b> — ~${formatQ(candidate.montoTipico)}/mes (suele caer el día ${candidate.diaTipico})`,
      esIngreso
        ? '¿Lo aprendo como ingreso recurrente? Así podré proyectar cuánto te falta por entrar cada mes.'
        : '¿Lo aprendo como recurrente para tus análisis?',
    ].join('\n'),
    {
      keyboard: [
        [
          { text: '✅ Sí, es recurrente', callback_data: `rec:y:${candidate.slug}` },
          { text: '❌ No', callback_data: `rec:n:${candidate.slug}` },
        ],
      ],
    },
  );
}

/**
 * Persistencia compartida (agente, voz y comprobantes): categorías nuevas,
 * agrupación por fecha efectiva (shortIds por día) y escritura de movimientos.
 */
async function persistOutcome(
  outcome: Pick<ParseOutcome, 'transactions' | 'createdCategories' | 'categoryEmoji'>,
  rawMessage: string,
  _today: string,
): Promise<Transaction[]> {
  const createdAt = new Date().toISOString();
  for (const cat of outcome.createdCategories) {
    await putCategoryIfAbsent({ ...cat, source: 'auto', createdAt });
  }

  // Agrupar por fecha efectiva: los shortIds son por día ("ayer gasté..." reserva en ayer).
  const byDate = new Map<string, typeof outcome.transactions>();
  for (const t of outcome.transactions) {
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
        ...(outcome.categoryEmoji.has(t.category) ? { emoji: outcome.categoryEmoji.get(t.category)! } : {}),
      });
    });
  }
  await putTransactions(txns);
  return txns;
}

/** Escudos: posibles duplicados y montos grandes en lo recién registrado. */
async function warningsFor(newTxns: Transaction[]): Promise<string[]> {
  const dates = [...new Set(newTxns.map((t) => t.date))];
  const existing = (await Promise.all(dates.map((d) => queryDay(d)))).flat();
  return registrationWarnings(newTxns, existing);
}

/** Botones 🗑️ por movimiento (callback_data del:<sk>, ≤64 bytes). */
function deleteKeyboard(txns: Transaction[]): InlineKeyboardButton[][] {
  const buttons = txns.map((t) => ({ text: `🗑️ #${t.shortId}`, callback_data: `del:${t.sk}` }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return rows;
}

// ── Saldos y snapshot para preguntas ───────────────────────────────────────

const loadBalances = loadBalancesReadonly;

function summarizePeriod(label: string, txns: Transaction[], days: number) {
  const agg = computeAggregates(txns, days);
  return {
    periodo: label,
    totalGastos: agg.totalGastos,
    totalIngresos: agg.totalIngresos,
    promedioDiarioGasto: agg.dailyAverage,
    topCategorias: Object.entries(agg.byCategory)
      .sort(([, a], [, b]) => b.sum - a.sum)
      .slice(0, 5)
      .map(([categoria, d]) => ({ categoria, total: d.sum })),
    gastosHormiga: agg.hormiga,
  };
}

/** Datos precalculados para responder/asesorar: el LLM solo narra sobre esto. */
async function buildSnapshot(today: string) {
  const month = monthPrefixGT(0);
  const prevMonth = monthPrefixGT(-1);
  const data = await loadAdvisorData(today, daysInMonth(month));

  return {
    fecha: today,
    saldos: data.balances.map((b) => ({
      cuenta: b.name,
      id: b.id,
      saldo: b.balance,
      alCorteDe: b.asOf,
      estimado: b.estimated,
    })),
    netoLiquido: data.netoLiquido,
    recurrentes: data.recurrentes.slice(0, 15),
    proyeccionFinDeMes: data.proyeccion,
    mesActual: summarizePeriod(
      `${monthLabelES(month)} (al día ${data.daysElapsed})`,
      data.monthTxns,
      data.daysElapsed,
    ),
    mesAnterior: summarizePeriod(monthLabelES(prevMonth), data.prevTxns, daysInMonth(prevMonth)),
    ultimos7Dias: summarizePeriod('últimos 7 días', data.weekTxns, 7),
  };
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

  // Respuesta a "¿es recurrente?": rec:y:<slug> / rec:n:<slug>
  if (data.startsWith('rec:')) {
    const confirmed = data.startsWith('rec:y:');
    const slug = data.slice(6);
    const record = (await listRecurring()).find((r) => r.slug === slug);
    if (!record) {
      await answerCallbackQuery(callback.id, 'Ese candidato ya no existe');
      return;
    }
    await putRecurring({
      ...record,
      status: confirmed ? 'confirmed' : 'rejected',
      source: 'user',
      updatedAt: new Date().toISOString(),
    });
    await answerCallbackQuery(callback.id, confirmed ? 'Aprendido ✅' : 'Anotado, no es recurrente');
    await sendMessage(
      chatId,
      confirmed
        ? `✅ Aprendido: <b>${escapeHtml(record.descripcion)}</b> (~${formatQ(record.montoTipico)}/mes, día ~${record.diaTipico}) ya cuenta como recurrente en tus análisis.`
        : `👍 Anotado: <b>${escapeHtml(record.descripcion)}</b> no es recurrente. No te lo vuelvo a preguntar.`,
    );
    return;
  }

  // Borrar un hecho aprendido: fct:d:<id>
  if (data.startsWith('fct:d:')) {
    const id = data.slice(6);
    const fact = (await listFacts()).find((f) => f.id === id);
    if (!fact) {
      await answerCallbackQuery(callback.id, 'Ese hecho ya no existe');
      return;
    }
    await deleteFact(id);
    await answerCallbackQuery(callback.id, 'Olvidado 🗑️');
    await sendMessage(chatId, `🗑️ Olvidado: "${escapeHtml(fact.text)}"`);
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

    case 'memoria': {
      const facts = await listFacts();
      if (facts.length === 0) {
        await sendMessage(
          chatId,
          '🧠 Aún no he aprendido hechos tuyos. Cuéntame cosas como "mi salario cae el 15 y el 29" y las recordaré.',
        );
        return;
      }
      const lines = [
        `🧠 <b>Lo que sé de ti</b> (${facts.length} hechos):`,
        '',
        ...facts.map((f, i) => `${i + 1}. ${escapeHtml(f.text)}`),
        '',
        'Borra alguno con los botones ⤵️',
      ];
      const keyboard: InlineKeyboardButton[][] = [];
      const buttons = facts.map((f, i) => ({ text: `🗑️ ${i + 1}`, callback_data: `fct:d:${f.id}` }));
      for (let i = 0; i < buttons.length; i += 4) keyboard.push(buttons.slice(i, i + 4));
      await sendMessage(chatId, lines.join('\n'), { keyboard });
      return;
    }

    case 'recurrentes': {
      const known = await listRecurring();
      const confirmed = known.filter((r) => r.status === 'confirmed');
      const pending = known.filter((r) => r.status === 'candidate');

      const lines = ['🔁 <b>Gastos recurrentes</b>', ''];
      if (confirmed.length > 0) {
        lines.push('<b>Aprendidos:</b>');
        for (const r of [...confirmed].sort((a, b) => b.montoTipico - a.montoTipico)) {
          const icon = r.tipo === 'ingreso' ? '💰' : '✅';
          lines.push(`${icon} ${escapeHtml(r.descripcion)} — ~${formatQ(r.montoTipico)}/mes (día ~${r.diaTipico})`);
        }
      } else {
        lines.push('Aún no has confirmado ninguno.');
      }
      if (pending.length > 0) {
        lines.push('', `<b>Por confirmar (${pending.length}):</b> responde con los botones ⤵️`);
      }
      await sendMessage(chatId, lines.join('\n'));

      // Reenviar la pregunta de los pendientes (por si quedaron sin responder)
      for (const r of pending.slice(0, 3)) {
        await sendRecurringQuestion(chatId, {
          slug: r.slug,
          descripcion: r.descripcion,
          categoria: r.categoria,
          tipo: r.tipo,
          montoTipico: r.montoTipico,
          diaTipico: r.diaTipico,
          meses: 0,
        });
      }
      return;
    }

    case 'saldo': {
      if (command.invalidArgs) {
        await sendMessage(
          chatId,
          'Uso: /saldo — ver saldos, o /saldo <cuenta> <monto> para ajustar la semilla.\nCuentas: banco, tarjeta, efectivo, kash. Ej: /saldo efectivo 350',
        );
        return;
      }
      if (command.set) {
        const accounts = await getOrSeedAccounts(today);
        const base =
          accounts.find((a) => a.id === command.set!.account) ??
          ({ ...DEFAULT_ACCOUNTS.find((d) => d.id === command.set!.account)!, seedBalance: 0, asOf: today, estimated: true, updatedAt: '' });
        let amount = command.set.amount;
        let note = '';
        if (command.set.account === 'tarjeta' && amount > 0) {
          amount = -amount;
          note = ' (interpretado como deuda: guardado en negativo)';
        }
        await putAccount({
          ...base,
          seedBalance: amount,
          asOf: today,
          estimated: false,
          updatedAt: new Date().toISOString(),
        });
        await sendMessage(chatId, `✅ ${base.emoji} ${base.name}: ${formatQ(amount)} al cierre de hoy${note}`);
      }
      const balances = await loadBalances(today);
      await sendMessage(chatId, renderSaldos(balances));
      return;
    }

    case 'proyeccion': {
      const data = await loadAdvisorData(today, daysInMonth(monthPrefixGT(0)));
      await sendMessage(chatId, renderProjection(data));
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
