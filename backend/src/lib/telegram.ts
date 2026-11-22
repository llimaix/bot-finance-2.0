import { config } from './config';
import { logger } from './logger';

const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

// ── Tipos mínimos del Bot API que usamos ──────────────────────────────────
export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  voice?: TelegramVoice;
  /** Fotos: variantes de menor a mayor resolución; usar la última. */
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  caption?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/** Error del Bot API con la causa cruda, para poder decidir según `description`. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} falló: ${description}`);
    this.name = 'TelegramApiError';
  }
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch con reintentos para fallos TRANSITORIOS: red caída ("fetch failed",
 * ECONNRESET), timeout del intento, y 5xx/429 de Telegram. Un parpadeo de red
 * no puede tirar una respuesta del agente ya calculada (incidente 15-jul:
 * "fetch failed" al enviar un consejo perfecto → el usuario recibió ⚠️).
 * Los 4xx NO se reintentan: son errores nuestros, no del camino.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) {
        logger.warn('telegram reintento por status', { label, attempt, status: res.status });
        await sleep(300 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn('telegram reintento por error de red', { label, attempt, error: String(err) });
        await sleep(300 * attempt);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithRetry(
    `${API_BASE}/bot${config.telegramBotToken}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    method,
  );
  const data = (await res.json()) as TelegramResponse<T>;
  if (!res.ok || !data.ok) {
    logger.error('telegram api error', { method, status: res.status, description: data.description });
    throw new TelegramApiError(method, res.status, data.description ?? String(res.status));
  }
  return data.result;
}

/** Tags que Telegram entiende en parse_mode: "HTML". */
const TELEGRAM_TAGS = 'b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|code|pre|blockquote';
const PARSE_ENTITIES_ERROR = /can't parse entities/i;

/**
 * Degrada el HTML a texto plano legible: quita el marcado que Telegram acepta
 * y devuelve las entidades a su carácter. Un "<monto>" mal escapado sobrevive
 * tal cual, que es justo lo que el mensaje quería mostrar.
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(new RegExp(`</?(?:${TELEGRAM_TAGS})(?:\\s[^>]*)?>`, 'gi'), '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export async function sendMessage(
  chatId: string | number,
  html: string,
  opts?: { keyboard?: InlineKeyboardButton[][] },
): Promise<void> {
  const body = {
    chat_id: chatId,
    ...(opts?.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  };
  try {
    await call('sendMessage', { ...body, text: html, parse_mode: 'HTML' });
  } catch (err) {
    // Un solo tag mal formado NO puede costar el mensaje entero: perder el
    // marcado es cosmético, perder el aviso es el incidente 29/30-jul (dos días
    // sin guardián por un "<monto>" literal). Reenvía en texto plano.
    if (!(err instanceof TelegramApiError) || !PARSE_ENTITIES_ERROR.test(err.description)) throw err;
    logger.error('html inválido: reenviando en texto plano', { description: err.description });
    await call('sendMessage', { ...body, text: toPlainText(html) });
  }
}

/** Muestra "escribiendo..." mientras el agente piensa (efímero, ~5s). */
export async function sendTyping(chatId: string | number): Promise<void> {
  await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
}

/** Cierra el "spinner" del botón inline; el texto aparece como toast. */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}

/** Envía un archivo (p.ej. el CSV de /export) como documento adjunto. */
export async function sendDocument(
  chatId: string | number,
  filename: string,
  content: string | Buffer,
  caption?: string,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  const bytes = new Uint8Array(typeof content === 'string' ? Buffer.from(content) : content);
  form.append('document', new Blob([bytes]), filename);

  const res = await fetchWithRetry(
    `${API_BASE}/bot${config.telegramBotToken}/sendDocument`,
    { method: 'POST', body: form },
    'sendDocument',
  );
  const data = (await res.json()) as TelegramResponse<unknown>;
  if (!res.ok || !data.ok) {
    logger.error('telegram api error', { method: 'sendDocument', status: res.status, description: data.description });
    throw new TelegramApiError('sendDocument', res.status, data.description ?? String(res.status));
  }
}

/** Descarga un archivo de Telegram (notas de voz ≤ 20MB vía getFile). */
export async function getFileBuffer(fileId: string): Promise<Buffer> {
  const file = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('getFile no devolvió file_path');
  const res = await fetchWithRetry(
    `${API_BASE}/file/bot${config.telegramBotToken}/${file.file_path}`,
    {},
    'getFileBuffer',
  );
  if (!res.ok) throw new Error(`Descarga de archivo falló: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
