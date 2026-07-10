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

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  voice?: TelegramVoice;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
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

export async function sendMessage(chatId: string | number, html: string): Promise<void> {
  await call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' });
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
