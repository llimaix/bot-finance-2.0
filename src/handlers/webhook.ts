import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from '../lib/config';
import { tryClaimUpdate } from '../lib/dynamo';
import { logger } from '../lib/logger';
import type { TelegramUpdate } from '../lib/telegram';

const lambda = new LambdaClient({});

const OK: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: 'ok' };

/**
 * Webhook THIN: valida, deduplica, filtra y delega el trabajo real al
 * processor por invocación asíncrona. Responde 200 en milisegundos — los
 * timeouts del HTTP API (30s) dejan de ser una restricción para el agente.
 */
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

  // 4. Delegar al processor (asíncrono) y responder 200 de inmediato
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: config.processorFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ update })),
      }),
    );
  } catch (err) {
    // Error aquí = update perdido: log ruidoso para que dispare la alarma.
    logger.error('no se pudo invocar el processor', {
      updateId: update.update_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

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
