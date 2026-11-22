import { ulid } from 'ulid';
import { NO_WRITE_DISCLAIMER, needsDeterministicRegister, needsNoWriteDisclaimer, runAgent } from './ai/agent';
import type { AgentDeps } from './ai/agent';
import { answerQuestion, correctTransaction, materializeParsed, parseReceipt, parseTransactions } from './ai/parse';
import type { DatedTransaction, ParseOutcome } from './ai/parse';
import { DEFAULT_ACCOUNTS, renderAffectedBalances, renderSaldos } from './accounts';
import { renderMetas, suggestBudgets } from './budgets';
import { resolveCategory } from './categories';
import { computeAggregates } from './aggregates';
import { CARD_PAYMENT_DUP_DAYS, enforceStatedMethod, registrationWarnings } from './guards';
import { loadAdvisorData, loadBalancesReadonly, renderProjection } from './insights';
import { detectRecurring, findNewCandidates, normalizeDesc } from './recurring';
import { summarizeSearch } from './search';
import { renderCosto, summarizeUsage } from './usage';
import type { RecurringPayment } from './recurring';
import { HELP_TEXT, matchCommand, matchCorrection, matchMethodAnswer } from './commands';
import { config } from './config';
import type { Command } from './commands';
import { addDaysTo, daysAgoGT, daysElapsedInMonthGT, daysInMonth, monthLabelES, monthPrefixGT, todayGT } from './dates';
import {
  appendConversation,
  deleteBudget,
  deleteFact,
  deleteTransaction,
  findByShortId,
  getConversation,
  getLastRecurringAskAt,
  getOrSeedAccounts,
  getTransaction,
  getUsage,
  listBudgets,
  listCategories,
  listFacts,
  listRecurring,
  putBudget,
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
  setLastRecurringAskAt,
  tryClaimUpdate,
  updateTransactionFields,
} from './dynamo';
import {
  code,
  escapeHtml,
  formatQ,
  renderConfirmation,
  renderDay,
  renderTxnLine,
  renderWeek,
  sumSpent,
  toCsv,
} from './format';
import { budgetMs, fits, remainingMs } from './deadline';
import { logger } from './logger';
import { changeUserName, currentUserName } from './profile';
import type { ConfigSnapshot } from './v2/config';
import { toCents } from './v2/money';
import { applyUndo } from './v2/repo';
import { loadBalancesV2, renderAffectedV2, renderSaldosV2 } from './v2/saldos';
import { planRegistroV2 } from './v2/registro';
import type { PropuestaV2 } from './v2/registro';
import { crearCuenta, editarCuenta, gestionarEntidad, loadSnapshot, renderConfig } from './v2/service';
import type { ServiceResult } from './v2/service';
import { buildReport } from './report';
import { getSttProvider } from './stt';
import { answerCallbackQuery, getFileBuffer, sendDocument, sendMessage, sendTyping } from './telegram';
import type {
  InlineKeyboardButton,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from './telegram';
import type { Method, Transaction } from './types';

/** Tope del agente por mensaje (MiniMax-M3 tiene picos de latencia largos). */
const AGENT_TIMEOUT_MS = 90_000;
/** Parser forzado de la red de seguridad (30s de LLM) + guardar y confirmar. */
const SAFETY_NET_MS = 35_000;

/**
 * Procesamiento del update de Telegram (corre en la Lambda processor, invocada
 * de forma asíncrona por el webhook: aquí hay minutos de presupuesto, no 30s).
 */
export async function processUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const callback = update.callback_query;
  const senderId = message?.chat.id ?? callback?.from.id;
  if (!senderId) return;

  // Deduplicación AQUÍ (no en el webhook): un update_id se procesa una sola
  // vez pase lo que pase — reintento de Telegram, reintento async de Lambda,
  // o doble invocación. Si el claim falla por un error de infra, procesamos
  // igual (mejor un raro duplicado que perder el mensaje del usuario).
  if (typeof update.update_id === 'number') {
    let firstTime = true;
    try {
      firstTime = await tryClaimUpdate(update.update_id);
    } catch (err) {
      logger.error('dedup falló; proceso el update igual', {
        updateId: update.update_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!firstTime) {
      logger.info('update duplicado ignorado', { updateId: update.update_id });
      return;
    }
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
    const errorReply = friendlyError(err);
    await sendMessage(senderId, errorReply).catch((sendErr) =>
      logger.error('no se pudo enviar el mensaje de error', { error: String(sendErr) }),
    );
    // El fallo QUEDA en la memoria conversacional: sin esto, un "intenta de
    // nuevo" posterior re-ejecuta lo último que el agente sí recuerda
    // (incidente 14-jul: re-marcó "sin movimientos" tras fallar una foto).
    if (message) {
      await rememberExchange(describeMessage(message), `[FALLÓ con este error] ${errorReply}`);
    }
    if (callback) await answerCallbackQuery(callback.id).catch(() => undefined);
  }
}

/** Resumen best-effort de un mensaje para la memoria (el error pudo ocurrir
 *  antes de transcribir/leer, así que se describe lo que se RECIBIÓ). */
function describeMessage(message: TelegramMessage): string {
  if (message.photo || message.document?.mime_type?.startsWith('image/')) {
    return `[📷 foto de comprobante]${message.caption ? ` ${message.caption}` : ''}`;
  }
  if (message.voice) return '[🎙️ nota de voz]';
  return message.text ?? '[mensaje]';
}

/** Errores con cara: el usuario merece saber qué pasó, no un ⚠️ genérico. */
function friendlyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || /timeout|aborted/i.test(msg)) {
    return '⏳ Me tardé más de la cuenta pensando en eso y lo corté. Inténtalo de nuevo, o divídelo en partes más pequeñas.';
  }
  return '⚠️ No pude procesar esto, intenta de nuevo o escríbelo como texto.';
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function rememberExchange(userText: string, assistantText: string): Promise<void> {
  await appendConversation([
    { role: 'user', text: truncate(userText), at: new Date().toISOString() },
    { role: 'assistant', text: truncate(assistantText), at: new Date().toISOString() },
  ]).catch((err) => logger.error('no se pudo guardar la conversación', { error: String(err) }));
}

/**
 * Mantiene vivo el "escribiendo…" de Telegram mientras corre trabajo largo
 * (el chat action expira a los ~5s; M3 puede razonar 30-90s y sin esto el
 * bot parece muerto). El intervalo SIEMPRE se limpia: un timer vivo colgaría
 * la invocación de Lambda.
 */
async function withTyping<T>(chatId: number, work: () => Promise<T>): Promise<T> {
  await sendTyping(chatId).catch(() => undefined);
  const interval = setInterval(() => {
    sendTyping(chatId).catch(() => undefined);
  }, 5_000);
  try {
    return await work();
  } finally {
    clearInterval(interval);
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
    const outcome = await withTyping(chatId, () => parseReceipt(image, mediaType, message.caption ?? null));

    // Modelo v2: lo leído pasa por el agente como texto. Así la terminación
    // ("terminada en 1111") la resuelve el código, y si no se conoce o falta
    // la cuenta, el agente pregunta y la aprende (mismo flujo que el texto).
    if (config.accountsModel === 'v2') {
      if (outcome.transactions.length === 0) {
        await sendMessage(chatId, '🧾 No pude leer movimientos en la imagen. ¿Me cuentas el monto y qué fue en texto?');
        return;
      }
      await agentFlow(chatId, today, describeReceiptForAgent(outcome, message.caption ?? null, today));
      return;
    }

    // Auditoría: lo que la visión leyó queda en el movimiento (responde "¿qué leíste?")
    const vision =
      outcome.transactions.map((t) => `${t.description} Q${t.amount}${t.date !== today ? ` (${t.date})` : ''}`).join('; ') ||
      'nada legible';
    const rawMessage = `📷 ${message.caption ?? 'foto de comprobante'} | visión leyó: ${vision}`;

    const sent = await saveAndConfirm(chatId, today, outcome, rawMessage, {
      header: '🧾 Comprobante procesado',
      emptyReply: '🧾 No pude leer movimientos en la imagen. ¿Me cuentas el monto y qué fue en texto?',
    });
    await rememberExchange(message.caption ? `📷 comprobante: ${message.caption}` : '📷 comprobante', sent);
    return;
  }

  if (message.voice) {
    const audio = await getFileBuffer(message.voice.file_id);
    const transcript = await withTyping(chatId, () =>
      getSttProvider().transcribe(audio, message.voice!.mime_type),
    );
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
    await rememberExchange(text, `[atendí el comando /${command.kind}]`);
    return;
  }

  // Modelo v2: "corrige #N" pasa por el agente (corregir_movimiento mantiene
  // v2); la corrección directa de v1 no conoce origen/destino.
  const correction = config.accountsModel === 'v1' ? matchCorrection(text) : null;
  if (correction) {
    const sent = await handleCorrection(chatId, today, correction.shortId, correction.text);
    await rememberExchange(text, sent);
    return;
  }

  // Respuesta a "¿de qué cuenta salió?": aplica el método al gasto pendiente
  // (method 'na') de forma DETERMINISTA — antes dependía de que M3 lo
  // reconstruyera de memoria y se perdía el dato (incidente TV 24-jul).
  const methodAnswer = matchMethodAnswer(text);
  if (methodAnswer) {
    const sent = await completePendingMethod(chatId, today, methodAnswer);
    if (sent) {
      await rememberExchange(text, sent);
      return;
    }
    // sin gasto pendiente: quizá no era una respuesta de método → sigue al agente
  }

  await agentFlow(chatId, today, text);
}

/** Aplica el método al gasto/retiro con cuenta pendiente ('na') más reciente.
 *  Devuelve la confirmación, o null si no había ninguno pendiente. */
async function completePendingMethod(chatId: number, today: string, method: Method): Promise<string | null> {
  const recent = await queryRange(daysAgoGT(1), today);
  const pend = recent
    .filter((t) => (t.type === 'gasto' || t.type === 'retiro') && t.method === 'na')
    .at(-1);
  if (!pend) return null;
  await updateTransactionFields(pend.sk, {
    amount: pend.amount,
    type: pend.type,
    category: pend.category,
    method,
    description: pend.description,
    emoji: pend.emoji ?? '🏷️',
  });
  const after: Transaction = { ...pend, method };
  const balanceLines = await affectedBalanceLines([after], today);
  const reply = [
    `✅ Listo, apliqué ${method} a:`,
    `${renderTxnLine(after)}${pend.date !== today ? ` · 📅 ${pend.date}` : ''}`,
    ...balanceLines,
  ].join('\n');
  await sendMessage(chatId, reply);
  logger.info('método pendiente aplicado', { sk: pend.sk, method, amount: pend.amount });
  return reply;
}

// ── Agente conversacional (texto y voz) ────────────────────────────────────

/** Sección HOY/AYER del contexto del agente, con "NINGUNO" explícito. */
function renderRecentSection(etiqueta: 'HOY' | 'AYER', fecha: string, movs: ReadonlyArray<Transaction>): string {
  const header = `Movimientos registrados ${etiqueta} (${fecha}): ${movs.length === 0 ? (etiqueta === 'HOY' ? 'NINGUNO' : 'ninguno') : movs.length}`;
  if (movs.length === 0) return header;
  const lines = movs.map((t) => `  - #${t.shortId} ${formatQ(t.amount)} ${t.method} ${t.type} · ${t.description}`);
  return `${header}\n${lines.join('\n')}`;
}

/** Envía el resumen de una configuración v2 con ↩️ Deshacer y devuelve al agente qué pasó. */
async function sendConfigResult(chatId: number, result: ServiceResult): Promise<unknown> {
  if (!result.ok) return { ok: false, errores: result.errors };
  await sendMessage(chatId, result.html, {
    keyboard: [[{ text: '↩️ Deshacer', callback_data: `und:${result.undoId}` }]],
  });
  return {
    ok: true,
    guardado: result.texto,
    nota: 'El usuario ya recibió este resumen con un botón Deshacer. Confírmalo en una frase, sin repetir todos los datos.',
  };
}

/** La configuración v2 no debe tumbar el turno del agente si falla al leerse. */
async function loadConfigV2(): Promise<ConfigSnapshot> {
  try {
    return await loadSnapshot();
  } catch (err) {
    logger.error('no se pudo leer la configuración v2', { error: String(err) });
    return { cuentas: [], entidades: [] };
  }
}

/**
 * Modelo v2: la lectura de la visión convertida en mensaje para el agente. La
 * terminación va con su contexto ("terminada en 1111") para que el resolvedor
 * la imponga como cualquier otra terminación escrita por el usuario.
 */
function describeReceiptForAgent(outcome: ParseOutcome, caption: string | null, today: string): string {
  const lineas = outcome.transactions.map(
    (t) => `- ${t.type} de ${formatQ(t.amount)}: ${t.description} (categoría ${t.category})${t.date !== today ? `, fecha ${t.date}` : ''}`,
  );
  return [
    '📷 Comprobante enviado por foto. La lectura de la imagen dice:',
    ...lineas,
    ...(outcome.terminacion ? [`Pagado con la tarjeta terminada en ${outcome.terminacion}.`] : []),
    ...(caption ? [`Lo que escribió el usuario con la foto: "${caption}".`] : []),
    'Regístralo con registrar_movimientos (si no se sabe la cuenta, pregunta).',
  ].join('\n');
}

async function agentFlow(chatId: number, today: string, userText: string, transcript?: string): Promise<void> {
  await sendTyping(chatId);
  const [history, balances, cats, facts, recent, configV2] = await Promise.all([
    getConversation(),
    loadBalances(today),
    listCategories(),
    listFacts(),
    queryRange(daysAgoGT(1), today),
    loadConfigV2(),
  ]);

  const contextInfo = [
    `Cuentas (saldo actual): ${balances
      .map((b) => `${b.name} [id:${b.id}]: ${formatQ(b.balance)}${b.estimated ? ' (estimado)' : ''}`)
      .join('; ')}.`,
    // Modelo nuevo (v2): solo configuración, para que editar_cuenta sepa qué existe.
    `Cuentas configuradas en el modelo nuevo: ${
      configV2.cuentas.length > 0
        ? configV2.cuentas
            .map((c) => `${c.nombre} [id:${c.id}, ${c.tipo}${c.terminaciones.length ? `, ••${c.terminaciones.join('/••')}` : ''}${c.activa ? '' : ', cerrada'}]`)
            .join('; ')
        : 'ninguna todavía'
    }.`,
    `Catálogo de categorías: ${cats.map((c) => c.name).join(', ')}.`,
    ...(facts.length > 0
      ? [`Hechos que el usuario te ha enseñado:\n${facts.map((f) => `- ${f.text}`).join('\n')}`]
      : []),
    // Dos secciones TAJANTES HOY vs AYER: en una lista mezclada M3 confundía
    // los de ayer con los de hoy (21-jul: dijo "hoy hay 2 movimientos" que en
    // realidad eran de ayer). "HOY: NINGUNO" es la señal directa para "hoy nada".
    renderRecentSection('HOY', today, recent.filter((t) => t.date === today)),
    renderRecentSection('AYER', daysAgoGT(1), recent.filter((t) => t.date !== today)),
    'Los movimientos de arriba YA están registrados: NO los vuelvas a registrar. Si alguno hay que cambiarlo, usa corregir_movimiento/eliminar_movimiento con su número y su fecha.',
  ].join('\n');

  const collectedWarnings: string[] = [];
  const modelV2 = config.accountsModel === 'v2';
  const deps: AgentDeps = {
    today,
    contextInfo,
    ...(modelV2 ? { cuentasV2Ids: configV2.cuentas.filter((c) => c.activa).map((c) => c.id) } : {}),
    register: async (input) => {
      const outcome = await materializeParsed(input);
      if (modelV2) {
        // origen/destino llegan intactos (materializeParsed conserva los campos
        // extra); el CÓDIGO decide la cuenta y valida. Si algo no cuadra, no se
        // guarda nada y el agente pregunta.
        const plan = planRegistroV2(outcome.transactions as Array<DatedTransaction & PropuestaV2>, userText, configV2);
        if (!plan.ok) {
          return { txns: [], createdCategories: [], totalSpentToday: 0, advertencias: [], errores: plan.errores };
        }
        outcome.transactions = plan.txns;
      }
      const txns = await persistOutcome(outcome, userText, today);
      // Los txns YA están escritos: un fallo de LECTURA aquí no debe hacer
      // rechazar (haría creer al agente que no guardó → la red re-registraría).
      const [todayTxns, advertencias] = await Promise.all([
        queryDay(today).catch(() => txns),
        warningsFor(txns).catch(() => [] as string[]),
      ]);
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
    // El nombre se valida en código (changeUserName), no se confía en el modelo.
    setUserName: async (nombre) => changeUserName(nombre),
    // Modelo nuevo de cuentas: guardan directamente y el CÓDIGO envía el resumen
    // de lo guardado con ↩️ Deshacer (el modelo solo lo confirma en una frase).
    manageEntity: async (input) => sendConfigResult(chatId, await gestionarEntidad(input)),
    createAccount: async (input) => sendConfigResult(chatId, await crearCuenta(input, today)),
    editAccount: async (input) => sendConfigResult(chatId, await editarCuenta(input, today)),
    correctMovement: async ({ numero, fecha, cambios }) => {
      // Defensa en profundidad: el esquema ya exige > 0, pero `??` dejaría
      // pasar un 0 y un negativo invertiría los saldos.
      if (cambios.monto !== null && (!Number.isFinite(cambios.monto) || cambios.monto <= 0)) {
        return { ok: false, error: 'El monto corregido debe ser mayor que cero' };
      }
      const date = fecha ?? today;
      const txn = await findByShortId(date, numero);
      if (!txn) return { ok: false, error: `No existe el movimiento #${numero} del ${date}` };
      // Modelo v2: la cuenta y el tipo viven en origen/destino; cambiarlos aquí
      // descuadraría los saldos. Se elimina y se registra de nuevo.
      if (txn.v2 && (cambios.tipo !== null || cambios.metodo !== null)) {
        return {
          ok: false,
          error:
            'En el modelo nuevo, para cambiar la cuenta o el tipo: elimina el movimiento con eliminar_movimiento y regístralo de nuevo con la cuenta correcta.',
        };
      }

      let category = txn.category;
      let emoji = txn.emoji ?? '🏷️';
      if (cambios.categoria) {
        const catalog = await listCategories();
        const known = new Map(catalog.map((c) => [c.name, c]));
        const resolved = resolveCategory(cambios.categoria, known, []);
        if (resolved.created) {
          await putCategoryIfAbsent({ ...resolved.created, source: 'auto', createdAt: new Date().toISOString() });
          emoji = resolved.created.emoji;
        } else {
          emoji = known.get(resolved.name)?.emoji ?? emoji;
        }
        category = resolved.name;
      }

      const fields = {
        amount: cambios.monto ?? txn.amount,
        type: cambios.tipo ?? txn.type,
        category,
        method: cambios.metodo ?? txn.method,
        description: cambios.descripcion ?? txn.description,
      };
      await updateTransactionFields(txn.sk, {
        ...fields,
        emoji,
        // v2: el monto que usan los saldos se corrige junto con el derivado.
        ...(txn.v2 ? { v2: { ...txn.v2, montoCentavos: toCents(fields.amount) } } : {}),
      });
      return {
        ok: true,
        antes: { monto: txn.amount, tipo: txn.type, categoria: txn.category, metodo: txn.method, descripcion: txn.description },
        ahora: fields,
      };
    },
    deleteMovement: async ({ numero, fecha }) => {
      const date = fecha ?? today;
      const txn = await findByShortId(date, numero);
      if (!txn) return { ok: false, error: `No existe el movimiento #${numero} del ${date}` };
      await deleteTransaction(txn.sk);
      return { ok: true, eliminado: { numero, fecha: date, monto: txn.amount, descripcion: txn.description } };
    },
    searchMovements: async ({ desde, hasta, categoria, texto }) => {
      // acotar el rango para no barrer la tabla completa
      const from = desde <= hasta ? desde : hasta;
      const to = desde <= hasta ? hasta : desde;
      const txns = await queryRange(from, to);
      return { rango: { desde: from, hasta: to }, ...summarizeSearch(txns, { categoria, texto }) };
    },
    markRecurringPaid: async ({ descripcion }) => {
      const needle = normalizeDesc(descripcion);
      const confirmed = (await listRecurring()).filter((r) => r.status === 'confirmed');
      const match =
        confirmed.find((r) => normalizeDesc(r.descripcion) === needle) ??
        confirmed.find((r) => {
          const n = normalizeDesc(r.descripcion);
          return n.includes(needle) || needle.includes(n);
        });
      if (!match) {
        return {
          ok: false,
          error: `No encuentro un recurrente confirmado que coincida con "${descripcion}"`,
          recurrentesConfirmados: confirmed.map((r) => r.descripcion),
        };
      }
      const month = monthPrefixGT(0);
      await putRecurring({ ...match, paidThroughMonth: month, updatedAt: new Date().toISOString() });
      return { ok: true, marcadoPagado: { descripcion: match.descripcion, mes: month } };
    },
    setBudget: async ({ categoria, topeMensual }) => {
      const category = categoria.trim().toLowerCase();
      if (topeMensual === null) {
        const existing = (await listBudgets()).find((b) => b.category === category);
        if (!existing) return { ok: false, error: `No hay meta en "${category}"` };
        await deleteBudget(category);
        return { ok: true, metaEliminada: category };
      }
      const now = new Date().toISOString();
      await putBudget({ category, monthlyLimit: topeMensual, source: 'user', createdAt: now, updatedAt: now });
      return { ok: true, meta: { categoria: category, topeMensual } };
    },
  };

  // MiniMax-M3 razona largo: los picos de latencia superan los 45s. Hasta 90s,
  // pero sin pasar del límite de la invocación (M5: la voz ya pudo gastar parte).
  const result = await withTyping(chatId, () =>
    runAgent(userText, history, deps, { timeoutMs: budgetMs(AGENT_TIMEOUT_MS) }),
  );

  // ── Red de seguridad DETERMINISTA ────────────────────────────────────────
  // M3 llama la herramienta de registro de forma intermitente (~2 de 3): a
  // veces afirma "Hecho: Q135" sin registrar nada. Si el mensaje pedía un
  // registro y el agente NO ESCRIBIÓ NADA (ni corrigió/ajustó/marcó), lo
  // registramos con el parser forzado (100% confiable con M3). El control por
  // usedWriteTool evita doble-registrar cuando el agente corrigió/ajustó.
  // En modo v2 la red está apagada: el parser forzado no sabe de origen/destino
  // y crearía movimientos que el modelo nuevo no ve. Si el agente afirmó un
  // registro que no hizo, el aviso de "no se guardó" de abajo sigue saliendo.
  const needsSafetyNet = !modelV2 && needsDeterministicRegister(result.usedWriteTool, userText);
  const safetyNetFits = fits(SAFETY_NET_MS);
  if (needsSafetyNet && !safetyNetFits) {
    // M5: sin tiempo para el parser forzado. El aviso de "no se guardó" de
    // abajo sigue protegiendo si el agente afirmó un registro que no hizo.
    logger.warn('red de seguridad omitida por falta de tiempo', { restanteMs: remainingMs() });
  }
  if (needsSafetyNet && safetyNetFits) {
    const outcome = await parseTransactions(userText).catch((err) => {
      logger.error('red de seguridad: parseo falló', { error: String(err) });
      return null;
    });
    // Actúa si hay algo que registrar O una aclaración pendiente (p.ej. método
    // desconocido): antes, si el parser retenía el gasto para PREGUNTAR la
    // cuenta, la red descartaba la pregunta en silencio y el gasto se perdía
    // (incidente 20-jul: "pago Q10 GYM" sin método → gym perdido). saveAndConfirm
    // registra si hay txns, o envía la aclaración si solo hay pregunta.
    if (outcome && (outcome.transactions.length > 0 || outcome.clarification)) {
      logger.warn('red de seguridad: el agente no registró; recupero por parser', {
        userText,
        reply: result.text,
        recuperados: outcome.transactions.length,
        clarification: outcome.clarification ?? undefined,
      });
      const sent = await withTyping(chatId, () =>
        saveAndConfirm(chatId, today, outcome, transcript ?? userText, {
          header: '✅ Registrado',
          ...(transcript ? { transcript } : {}),
        }),
      );
      await rememberExchange(transcript ?? userText, sent);
      return; // saveAndConfirm ya envió (registro o pregunta) y disparó recurrentes
    }
  }
  // Afirmó una ESCRITURA que no ejecutó (y no se recuperó arriba): estampar la
  // verdad para no dejar creer un guardado que no ocurrió.
  if (needsNoWriteDisclaimer(result.usedWriteTool, result.text)) {
    result.text += NO_WRITE_DISCLAIMER;
  }

  const heard = transcript ? `🎙️ Escuché: "${escapeHtml(transcript)}"\n\n` : '';
  let reply = `${heard}${escapeHtml(result.text)}`;
  if (result.registered.length > 0) {
    reply += `\n\n${result.registered
      .map((t) => `${renderTxnLine(t)}${t.date !== today ? ` · 📅 ${t.date}` : ''}`)
      .join('\n')}`;
    // Saldos leídos DESPUÉS de registrar: los del contexto son de antes.
    const balanceLines = await affectedBalanceLines(result.registered, today);
    if (balanceLines.length > 0) reply += `\n${balanceLines.join('\n')}`;
  }
  for (const warning of collectedWarnings) {
    reply += `\n${escapeHtml(warning)}`;
  }
  await sendMessage(
    chatId,
    reply,
    result.registered.length > 0 ? { keyboard: deleteKeyboard(result.registered) } : undefined,
  );

  await rememberExchange(userText, result.text);

  if (result.registered.length > 0) {
    await askAboutNewRecurring(chatId).catch((err) =>
      logger.error('detección de recurrentes falló', { error: String(err) }),
    );
  }
}

// ── Registro compartido (voz y comprobantes) ───────────────────────────────

async function saveAndConfirm(
  chatId: number,
  today: string,
  outcome: ParseOutcome,
  rawMessage: string,
  opts: { transcript?: string; header?: string; emptyReply?: string },
): Promise<string> {
  const { transactions, clarification, noMovements, question, createdCategories } = outcome;

  // En respuestas de voz, mostrar siempre lo que se escuchó.
  const heard = opts.transcript ? `🎙️ Escuché: "${escapeHtml(opts.transcript)}"\n\n` : '';

  if (transactions.length === 0) {
    let reply: string;
    if (question) {
      const answer = await answerQuestion(question, await buildSnapshot(today));
      reply = `${heard}${escapeHtml(answer)}`;
    } else if (clarification) {
      reply = `${heard}❓ ${escapeHtml(clarification)}`;
    } else if (noMovements) {
      reply = `${heard}👍 Anotado: día sin movimientos.`;
    } else {
      reply =
        opts.emptyReply ??
        `${heard}👋 ¡Hola! No identifiqué movimientos en tu mensaje. Cuéntame tus gastos o ingresos del día, o dime "hoy nada" si no hubo.`;
    }
    await sendMessage(chatId, reply);
    return reply;
  }

  const txns = await persistOutcome(outcome, rawMessage, today);

  const [todayTxns, warnings, balanceLines] = await Promise.all([
    queryDay(today),
    warningsFor(txns),
    affectedBalanceLines(txns, today),
  ]);
  let reply = renderConfirmation({
    txns,
    today,
    totalSpentToday: sumSpent(todayTxns),
    balanceLines,
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
  return reply;
}

// ── Aprendizaje de gastos recurrentes ──────────────────────────────────────

const MAX_RECURRING_QUESTIONS = 2;
// No interrumpir cada registro: las preguntas de recurrentes esperan su turno.
const RECURRING_ASK_COOLDOWN_MS = 4 * 3600 * 1000;

/**
 * Detecta candidatos a recurrente que aún no están en la base de conocimientos
 * y se los pregunta al usuario con botones (máx 2, y no más de una tanda cada
 * 4 horas para no enterrar las confirmaciones). La respuesta queda aprendida:
 * confirmados alimentan al asesor, rechazados no se vuelven a preguntar.
 */
async function askAboutNewRecurring(chatId: number): Promise<void> {
  const lastAsk = await getLastRecurringAskAt();
  if (lastAsk && Date.now() - Date.parse(lastAsk) < RECURRING_ASK_COOLDOWN_MS) {
    return; // en cooldown: los candidatos seguirán ahí en la próxima tanda o en /recurrentes
  }

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
  if (candidates.length === 0) return;

  await setLastRecurringAskAt(new Date().toISOString());
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

  // Si el usuario NOMBRÓ la cuenta, el método no se negocia con el modelo: pasa
  // por aquí todo lo que se registra (texto, voz, foto y agente), así que la
  // regla no puede quedarse fuera de una ruta como pasó con los prompts.
  // Modelo v2: el método se deriva de origen/destino (ya decididos por el
  // resolvedor), así que la regla v1 no aplica.
  const isV2 = outcome.transactions.some((t) => 'v2' in t);
  const { txns: parsed, corrections } = isV2
    ? { txns: outcome.transactions, corrections: [] as unknown[] }
    : enforceStatedMethod(outcome.transactions, rawMessage);
  if (corrections.length > 0) {
    logger.info('método corregido por lo que dice el mensaje', { rawMessage, corrections });
  }

  // Agrupar por fecha efectiva: los shortIds son por día ("ayer gasté..." reserva en ayer).
  const byDate = new Map<string, typeof outcome.transactions>();
  for (const t of parsed) {
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
  const dates = [...new Set(newTxns.map((t) => t.date))].sort();
  // Un pago de tarjeta se compara contra su ciclo, no contra el día: el
  // comprobante trae la fecha del cierre y el registro cae cuando cae. Una
  // sola consulta por rango cubre la ventana.
  const window = newTxns.some((t) => t.type === 'transferencia' && t.category === 'deuda')
    ? CARD_PAYMENT_DUP_DAYS
    : 0;
  const existing = window
    ? await queryRange(addDaysTo(dates[0]!, -window), addDaysTo(dates[dates.length - 1]!, window))
    : (await Promise.all(dates.map((d) => queryDay(d)))).flat();
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

/** Saldo de las cuentas que tocaron estos movimientos, una línea por cuenta.
 *  Es un extra de la confirmación: si la lectura falla se omite (los
 *  movimientos ya están guardados y la confirmación debe llegar igual). */
async function affectedBalanceLines(txns: ReadonlyArray<Transaction>, today: string): Promise<string[]> {
  try {
    if (config.accountsModel === 'v2') return renderAffectedV2(txns, (await loadBalancesV2(today)).saldos);
    return renderAffectedBalances(txns, await loadBalances(today));
  } catch (err) {
    logger.error('saldos tras registrar fallaron', { error: String(err) });
    return [];
  }
}

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
    metasDeGasto: data.metas.map((m) => ({
      categoria: m.category,
      topeMensual: m.monthlyLimit,
      gastadoEsteMes: m.spent,
      porcentaje: m.pct,
      ritmoProyectado: m.paceProjected,
      estado: m.status,
    })),
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

  // ↩️ Deshacer una configuración del modelo nuevo (válido 24 h, una sola vez).
  if (data.startsWith('und:')) {
    const undone = await applyUndo(data.slice(4));
    await answerCallbackQuery(callback.id, undone ? 'Deshecho ↩️' : 'Ya no se puede deshacer');
    if (undone) await sendMessage(chatId, '↩️ Listo: dejé la configuración como estaba antes de ese cambio.');
    return;
  }

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

  // Respuesta a "¿te pongo esta meta?": bgt:y:<categoria>:<monto> / bgt:n:<categoria>
  if (data.startsWith('bgt:')) {
    if (data.startsWith('bgt:y:')) {
      const [category, rawAmount] = data.slice(6).split(':');
      const amount = Number.parseFloat(rawAmount ?? '');
      if (!category || !Number.isFinite(amount) || amount <= 0) {
        await answerCallbackQuery(callback.id, 'Meta inválida');
        return;
      }
      const now = new Date().toISOString();
      await putBudget({ category, monthlyLimit: amount, source: 'auto', createdAt: now, updatedAt: now });
      await answerCallbackQuery(callback.id, 'Meta fijada 🎯');
      await sendMessage(
        chatId,
        `🎯 Meta fijada: <b>${escapeHtml(category)}</b> ≤ ${formatQ(amount)}/mes. Sigue tu avance con /metas.`,
      );
    } else {
      const category = data.slice(6);
      await answerCallbackQuery(callback.id, 'Anotado, sin meta');
      await sendMessage(chatId, `👍 Sin meta en ${escapeHtml(category)}. Puedes ponerla luego con ${code(`/metas ${category} <monto>`)}.`);
    }
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

    case 'cuentas':
      await sendMessage(chatId, renderConfig(await loadSnapshot()));
      return;

    case 'nombre': {
      if (command.name === null) {
        const actual = currentUserName();
        await sendMessage(
          chatId,
          actual
            ? `Te llamo <b>${escapeHtml(actual)}</b>. Para cambiarlo: /nombre &lt;tu nombre&gt;`
            : 'Aún no sé cómo llamarte. Dímelo con: /nombre &lt;tu nombre&gt;',
        );
        return;
      }
      const result = await changeUserName(command.name);
      await sendMessage(
        chatId,
        result.ok ? `✅ Te llamaré <b>${escapeHtml(result.nombre)}</b>.` : `⚠️ ${escapeHtml(result.error)}`,
      );
      return;
    }

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
      // Modelo v2: saldos por partida doble; los ajustes se piden en lenguaje
      // natural (editar_cuenta) porque las cuentas ya no son las 5 fijas.
      if (config.accountsModel === 'v2') {
        if (command.set || command.invalidArgs) {
          await sendMessage(chatId, 'Para ajustar un saldo dímelo en lenguaje natural, por ejemplo: "mi efectivo es Q350" o "debo Q1,500 en la Visa".');
          return;
        }
        await sendMessage(chatId, renderSaldosV2((await loadBalancesV2(today)).saldos));
        return;
      }
      if (command.invalidArgs) {
        await sendMessage(
          chatId,
          `Uso: /saldo — ver saldos, o ${code('/saldo <cuenta> <monto>')} para ajustar la semilla.\nCuentas: banco, banrural, tarjeta, efectivo, kash. Ej: ${code('/saldo efectivo 350')}`,
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

    case 'costo': {
      const month = monthPrefixGT(0);
      const item = await getUsage(month);
      await sendMessage(chatId, renderCosto(summarizeUsage(item), monthLabelES(month)));
      return;
    }

    case 'metas': {
      if (command.invalidArgs) {
        await sendMessage(
          chatId,
          'Uso: /metas — ver progreso · /metas sugerir — propuestas según tu historial · /metas comida 1500 — fijar · /metas quitar comida',
        );
        return;
      }
      const action = command.action;

      if (action.op === 'fijar') {
        const now = new Date().toISOString();
        await putBudget({
          category: action.category,
          monthlyLimit: action.amount,
          source: 'user',
          createdAt: now,
          updatedAt: now,
        });
        await sendMessage(chatId, `🎯 Meta fijada: ${escapeHtml(action.category)} ≤ ${formatQ(action.amount)}/mes.`);
        return;
      }

      if (action.op === 'quitar') {
        const existing = (await listBudgets()).find((b) => b.category === action.category);
        if (!existing) {
          await sendMessage(chatId, `No tienes meta en "${escapeHtml(action.category)}". Mira /metas.`);
          return;
        }
        await deleteBudget(action.category);
        await sendMessage(chatId, `🗑️ Meta de ${escapeHtml(action.category)} eliminada.`);
        return;
      }

      if (action.op === 'sugerir') {
        const [prevTxns, prev2Txns, budgets, recurring] = await Promise.all([
          queryMonth(monthPrefixGT(-1)),
          queryMonth(monthPrefixGT(-2)),
          listBudgets(),
          listRecurring(),
        ]);
        const suggestions = suggestBudgets(
          [prevTxns, prev2Txns],
          budgets,
          recurring.filter((r) => r.status === 'confirmed'),
        );
        if (suggestions.length === 0) {
          await sendMessage(
            chatId,
            '🤷 No tengo suficiente historial (o ya tienes metas en tus categorías fuertes). Fija una directo: /metas comida 1500',
          );
          return;
        }
        for (const s of suggestions) {
          await sendMessage(
            chatId,
            `🎯 En <b>${escapeHtml(s.category)}</b> vienes gastando ~${formatQ(s.monthlyAverage)}/mes. ¿Te pongo meta de <b>${formatQ(s.suggested)}</b>?`,
            {
              keyboard: [
                [
                  { text: '✅ Sí, esa meta', callback_data: `bgt:y:${s.category}:${s.suggested}` },
                  { text: '❌ No', callback_data: `bgt:n:${s.category}` },
                ],
              ],
            },
          );
        }
        return;
      }

      const data = await loadAdvisorData(today, daysInMonth(monthPrefixGT(0)));
      await sendMessage(chatId, renderMetas(data.metas, data.daysElapsed));
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
): Promise<string> {
  const original = await findByShortId(today, shortId);
  if (!original) {
    const reply = `No encontré el movimiento #${shortId} de hoy.`;
    await sendMessage(chatId, reply);
    return reply;
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
  const reply = lines.join('\n');
  await sendMessage(chatId, reply);
  return reply;
}
