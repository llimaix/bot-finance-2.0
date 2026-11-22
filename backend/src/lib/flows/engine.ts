/**
 * Motor de flujos guiados: NÚCLEO PURO (sin DynamoDB ni Telegram).
 *
 * `step(def, estado, evento)` devuelve el estado siguiente, los mensajes a
 * enviar y, si el usuario confirmó, los datos a guardar. El adaptador
 * (runner.ts) persiste el estado y hace el IO. Así toda la lógica del flujo se
 * prueba sin AWS.
 *
 * Callbacks: `flw:<nonce>:<acción>`, dentro de los 64 bytes de Telegram. El
 * nonce cambia en cada flujo: un botón de una tarjeta vieja no hace nada.
 */
import type { InlineKeyboardButton } from '../telegram';

export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

export type StepDef =
  | { key: string; label: string; kind: 'text'; prompt: string; parse: (text: string) => ParseResult }
  | {
      key: string;
      label: string;
      kind: 'choice';
      prompt: string;
      options: ReadonlyArray<{ label: string; value: string }>;
    };

export type FlowData = Record<string, string>;

export interface FlowDef {
  id: string;
  /** Nombre corto para mensajes ("perfil", "nueva cuenta"). */
  title: string;
  steps: ReadonlyArray<StepDef>;
  /** Tarjeta de confirmación (HTML de Telegram, con los valores escapados). */
  summary: (data: FlowData) => string;
  /** Guarda validando en código y devuelve el mensaje final. Lo ejecuta el adaptador. */
  commit: (data: FlowData) => Promise<string>;
}

export interface FlowState {
  flowId: string;
  nonce: string;
  /** Paso que se está preguntando; null = en la tarjeta de confirmación. */
  step: number | null;
  /** Se está corrigiendo un campo suelto: al responderlo se vuelve a la tarjeta. */
  editing: boolean;
  data: FlowData;
  /** Instante de expiración (ms epoch). */
  expiresAt: number;
}

export type FlowEvent =
  | { type: 'text'; text: string }
  | { type: 'option'; index: number }
  | { type: 'confirm' }
  | { type: 'editMenu' }
  | { type: 'edit'; index: number }
  | { type: 'summary' }
  | { type: 'cancel' };

export interface OutMessage {
  html: string;
  keyboard?: InlineKeyboardButton[][];
}

export interface StepResult {
  /** null = el flujo terminó (confirmado o cancelado) y debe borrarse. */
  state: FlowState | null;
  messages: OutMessage[];
  /** Presente solo al confirmar: datos que el adaptador debe guardar con def.commit. */
  commit?: FlowData;
}

export const FLOW_TTL_MS = 24 * 3600 * 1000;
export const CANCEL_HINT = '<i>Escribe /cancelar para salir.</i>';

const cb = (nonce: string, action: string): string => `flw:${nonce}:${action}`;

/** Estado inicial: salta los pasos ya rellenados (propuestas del agente). */
export function startState(def: FlowDef, prefill: FlowData, nonce: string, now: number): StepResult {
  const data: FlowData = { ...prefill };
  const first = def.steps.findIndex((s) => data[s.key] === undefined);
  const state: FlowState = {
    flowId: def.id,
    nonce,
    step: first === -1 ? null : first,
    editing: false,
    data,
    expiresAt: now + FLOW_TTL_MS,
  };
  return { state, messages: [render(def, state)] };
}

export function isExpired(state: FlowState, now: number): boolean {
  return now >= state.expiresAt;
}

/** Mensaje que corresponde al estado: la pregunta del paso o la tarjeta. */
export function render(def: FlowDef, state: FlowState): OutMessage {
  if (state.step === null) {
    return {
      html: def.summary(state.data),
      keyboard: [
        [
          { text: '✅ Guardar', callback_data: cb(state.nonce, 'ok') },
          { text: '✏️ Corregir', callback_data: cb(state.nonce, 'ed') },
          { text: '❌ Cancelar', callback_data: cb(state.nonce, 'x') },
        ],
      ],
    };
  }
  const s = def.steps[state.step]!;
  if (s.kind === 'choice') {
    return {
      html: `${s.prompt}\n\n${CANCEL_HINT}`,
      keyboard: s.options.map((o, i) => [{ text: o.label, callback_data: cb(state.nonce, `o:${i}`) }]),
    };
  }
  return { html: `${s.prompt}\n\n${CANCEL_HINT}` };
}

function editMenu(def: FlowDef, state: FlowState): OutMessage {
  return {
    html: '¿Qué quieres corregir?',
    keyboard: [
      ...def.steps.map((s, i) => [{ text: `✏️ ${s.label}`, callback_data: cb(state.nonce, `e:${i}`) }]),
      [{ text: '↩️ Volver', callback_data: cb(state.nonce, 'sm') }],
    ],
  };
}

/** Guarda el valor del paso actual y avanza (o vuelve a la tarjeta si se corregía). */
function accept(def: FlowDef, state: FlowState, value: string): StepResult {
  const current = state.step!;
  const data = { ...state.data, [def.steps[current]!.key]: value };
  const nextStep = !state.editing && current + 1 < def.steps.length ? current + 1 : null;
  const next: FlowState = { ...state, data, step: nextStep, editing: false };
  return { state: next, messages: [render(def, next)] };
}

export function step(def: FlowDef, state: FlowState, event: FlowEvent): StepResult {
  const stay = (html: string): StepResult => ({ state, messages: [{ html }, render(def, state)] });

  switch (event.type) {
    case 'cancel':
      return { state: null, messages: [{ html: `❌ Cancelado (${def.title}): no guardé nada.` }] };

    case 'text': {
      if (state.step === null) return stay('Usa los botones de la tarjeta para guardar, corregir o cancelar.');
      const s = def.steps[state.step]!;
      if (s.kind === 'choice') return stay('Elige una de las opciones con los botones.');
      const parsed = s.parse(event.text);
      if (!parsed.ok) return stay(`⚠️ ${parsed.error}`);
      return accept(def, state, parsed.value);
    }

    case 'option': {
      if (state.step === null) return { state, messages: [] };
      const s = def.steps[state.step]!;
      const option = s.kind === 'choice' ? s.options[event.index] : undefined;
      if (!option) return { state, messages: [] };
      return accept(def, state, option.value);
    }

    case 'confirm':
      if (state.step !== null) return { state, messages: [] };
      return { state: null, messages: [], commit: state.data };

    case 'editMenu':
      if (state.step !== null) return { state, messages: [] };
      return { state, messages: [editMenu(def, state)] };

    case 'edit': {
      if (state.step !== null || !def.steps[event.index]) return { state, messages: [] };
      const next: FlowState = { ...state, step: event.index, editing: true };
      return { state: next, messages: [render(def, next)] };
    }

    case 'summary':
      if (state.step !== null) return { state, messages: [] };
      return { state, messages: [render(def, state)] };
  }
}

/** Traduce `flw:<nonce>:<acción>` a evento. null si no es un callback de flujo válido. */
export function decodeCallback(data: string): { nonce: string; event: FlowEvent } | null {
  const m = data.match(/^flw:([a-z0-9]+):(ok|ed|x|sm|o:\d+|e:\d+)$/);
  if (!m) return null;
  const [, nonce, action] = m as unknown as [string, string, string];
  if (action === 'ok') return { nonce, event: { type: 'confirm' } };
  if (action === 'ed') return { nonce, event: { type: 'editMenu' } };
  if (action === 'x') return { nonce, event: { type: 'cancel' } };
  if (action === 'sm') return { nonce, event: { type: 'summary' } };
  const index = Number(action.slice(2));
  return { nonce, event: action.startsWith('o:') ? { type: 'option', index } : { type: 'edit', index } };
}
