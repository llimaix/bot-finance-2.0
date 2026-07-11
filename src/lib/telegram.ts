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

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${config.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!res.ok || !data.ok) {
    logger.error('telegram api error', { method, status: res.status, description: data.description });
    throw new Error(`Telegram ${method} falló: ${data.description ?? res.status}`);
  }
  return data.result;
}

export async function sendMessage(
  chatId: string | number,
  html: string,
  opts?: { keyboard?: InlineKeyboardButton[][] },
): Promise<void> {
  await call('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    ...(opts?.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  });
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

  const res = await fetch(`${API_BASE}/bot${config.telegramBotToken}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as TelegramResponse<unknown>;
  if (!res.ok || !data.ok) {
    logger.error('telegram api error', { method: 'sendDocument', status: res.status, description: data.description });
    throw new Error(`Telegram sendDocument falló: ${data.description ?? res.status}`);
  }
}

/** Descarga un archivo de Telegram (notas de voz ≤ 20MB vía getFile). */
export async function getFileBuffer(fileId: string): Promise<Buffer> {
  const file = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('getFile no devolvió file_path');
  const res = await fetch(`${API_BASE}/file/bot${config.telegramBotToken}/${file.file_path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Descarga de archivo falló: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
