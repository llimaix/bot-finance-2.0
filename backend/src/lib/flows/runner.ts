/**
 * Adaptador del motor de flujos: lee y guarda FLOW#activo, ejecuta el commit
 * del flujo y envía los mensajes. Toda la lógica de pasos vive en engine.ts.
 */
import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { deleteActiveFlow, getActiveFlow, saveActiveFlow } from '../dynamo';
import type { StoredFlow } from '../dynamo';
import { escapeHtml } from '../format';
import { logger } from '../logger';
import { answerCallbackQuery, sendMessage } from '../telegram';
import type { TelegramCallbackQuery } from '../telegram';
import { FLOWS } from './definitions';
import { decodeCallback, isExpired, render, startState, step } from './engine';
import type { FlowData, FlowDef, OutMessage, StepResult } from './engine';

const newNonce = (): string => randomBytes(5).toString('hex');

async function send(chatId: number, messages: OutMessage[]): Promise<void> {
  for (const m of messages) {
    await sendMessage(chatId, m.html, m.keyboard ? { keyboard: m.keyboard } : undefined);
  }
}

/** Flujo activo vigente; si expiró, se borra y se trata como inexistente. */
async function loadActive(): Promise<{ flow: StoredFlow; version: number; def: FlowDef } | null> {
  const found = await getActiveFlow();
  if (!found) return null;
  const def = FLOWS[found.flow.state.flowId];
  if (!def || isExpired(found.flow.state, Date.now())) {
    await deleteActiveFlow();
    return null;
  }
  return { ...found, def };
}

/** Persiste el resultado de un paso: commit, borrado o guardado del estado. */
async function apply(chatId: number, def: FlowDef, result: StepResult, version: number): Promise<void> {
  if (result.commit) {
    let final: string;
    try {
      final = await def.commit(result.commit);
    } catch (err) {
      // El flujo se conserva en la tarjeta: el usuario puede reintentar ✅.
      logger.error('no se pudo guardar el flujo', { flowId: def.id, error: String(err) });
      await sendMessage(chatId, '⚠️ No pude guardarlo. Intenta de nuevo con ✅ Guardar.');
      return;
    }
    await deleteActiveFlow();
    await send(chatId, [...result.messages, { html: final }]);
    return;
  }

  if (result.state === null) {
    await deleteActiveFlow();
    await send(chatId, result.messages);
    return;
  }

  try {
    await saveActiveFlow({ state: result.state }, version);
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    await sendMessage(chatId, '⚠️ Recibí dos respuestas casi a la vez. Responde de nuevo, por favor.');
    return;
  }
  await send(chatId, result.messages);
}

/**
 * Inicia un flujo (o lo propone, si `prefill` ya trae todos los pasos: se salta
 * directo a la tarjeta de confirmación). Si hay otro flujo a medias, pregunta
 * antes de abandonarlo.
 */
export async function startFlow(chatId: number, flowId: string, prefill: FlowData = {}): Promise<void> {
  const def = FLOWS[flowId];
  if (!def) throw new Error(`Flujo desconocido: ${flowId}`);

  const active = await loadActive();
  if (active && active.flow.state.flowId !== flowId) {
    const { state } = active.flow;
    await saveActiveFlow({ state, pending: { flowId, prefill } }, active.version);
    await sendMessage(
      chatId,
      `Tienes a medias: <b>${escapeHtml(active.def.title)}</b>. ¿Lo dejo y empiezo <b>${escapeHtml(def.title)}</b>?`,
      {
        keyboard: [
          [
            { text: '↪️ Dejarlo y empezar', callback_data: `flw:${state.nonce}:rp` },
            { text: '⏸️ Seguir con el actual', callback_data: `flw:${state.nonce}:kp` },
          ],
        ],
      },
    );
    return;
  }

  // Mismo flujo a medias: se reemplaza por el nuevo (p. ej. otra propuesta del agente).
  const result = startState(def, prefill, newNonce(), Date.now());
  if (active) await deleteActiveFlow();
  await saveActiveFlow({ state: result.state! }, 0);
  await send(chatId, result.messages);
}

/** Texto con un flujo activo. Devuelve false si no hay flujo (el mensaje sigue su ruta normal). */
export async function handleFlowText(chatId: number, text: string): Promise<boolean> {
  const active = await loadActive();
  if (!active) return false;
  await apply(chatId, active.def, step(active.def, active.flow.state, { type: 'text', text }), active.version);
  return true;
}

/** /cancelar. Devuelve false si no había flujo activo. */
export async function cancelActiveFlow(chatId: number): Promise<boolean> {
  const active = await loadActive();
  if (!active) return false;
  await apply(chatId, active.def, step(active.def, active.flow.state, { type: 'cancel' }), active.version);
  return true;
}

/** Botones `flw:`. Devuelve false si el callback no es de un flujo. */
export async function handleFlowCallback(callback: TelegramCallbackQuery): Promise<boolean> {
  const data = callback.data ?? '';
  if (!data.startsWith('flw:')) return false;
  const chatId = callback.message?.chat.id ?? callback.from.id;

  const active = await loadActive();
  const nonce = data.split(':')[1];
  if (!active || active.flow.state.nonce !== nonce) {
    await answerCallbackQuery(callback.id, 'Esa opción ya no aplica');
    return true;
  }
  await answerCallbackQuery(callback.id);

  // Respuesta a "tienes otro flujo a medias".
  if (data.endsWith(':rp') && active.flow.pending) {
    const { flowId, prefill } = active.flow.pending;
    await deleteActiveFlow();
    await startFlow(chatId, flowId, prefill);
    return true;
  }
  if (data.endsWith(':kp')) {
    await saveActiveFlow({ state: active.flow.state }, active.version);
    await send(chatId, [render(active.def, active.flow.state)]);
    return true;
  }

  const decoded = decodeCallback(data);
  if (!decoded) return true;
  await apply(chatId, active.def, step(active.def, active.flow.state, decoded.event), active.version);
  return true;
}
