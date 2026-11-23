/**
 * API de solo lectura de la Mini App (Lambda Function URL, auth AWS_IAM).
 *
 * Solo llega tráfico firmado por CloudFront (OAC). Además, cada petición debe
 * traer en `X-Telegram-Init-Data` el initData de Telegram (no en Authorization:
 * OAC sobrescribe ese header con su firma SigV4), validado con el token del bot
 * y del único usuario permitido.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from '../lib/config';
import { todayGT } from '../lib/dates';
import { logger } from '../lib/logger';
import { validateInitData } from '../lib/miniapp/auth';
import { loadDashboard } from '../lib/miniapp/dashboard';
import { loadSecrets } from '../lib/secrets';

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

const reply = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  if (event.rawPath !== '/api/dashboard') return reply(404, { error: 'not_found' });

  await loadSecrets();
  const auth = validateInitData(event.headers['x-telegram-init-data'], {
    botToken: config.telegramBotToken,
    allowedUserId: config.allowedChatId,
    maxAgeSeconds: Number(process.env.INIT_DATA_MAX_AGE_SECONDS || '86400'),
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!auth.ok) {
    // Sin el initData ni el id en el log: solo el motivo.
    logger.warn('mini app: acceso rechazado', { reason: auth.reason });
    return reply(auth.reason === 'forbidden_user' ? 403 : 401, { error: 'unauthorized' });
  }
  if (config.accountsModel !== 'v2') return reply(409, { error: 'requires_v2' });

  try {
    return reply(200, await loadDashboard(todayGT()));
  } catch (err) {
    logger.error('mini app: dashboard falló', { error: String(err) });
    return reply(500, { error: 'internal' });
  }
}
