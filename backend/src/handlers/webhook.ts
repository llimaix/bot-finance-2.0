import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { config } from '../lib/config';
import { logger } from '../lib/logger';
import { loadSecrets } from '../lib/secrets';
import type { TelegramUpdate } from '../lib/telegram';

const lambda = new LambdaClient({});

const OK: APIGatewayProxyStructuredResultV2 = { statusCode: 200, body: 'ok' };

/**
 * Webhook THIN: valida, filtra y delega el trabajo real al processor por
 * invocación asíncrona. Responde 200 en milisegundos. La DEDUPLICACIÓN vive
 * en el processor (no aquí): así un mismo update_id se procesa una sola vez
 * aunque Telegram reintente el webhook, aunque Lambda reintente el processor,
 * o aunque esta invocación falle en la respuesta pero haya llegado.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  await loadSecrets();

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

  // 2. Bot personal: cualquier otro chat/usuario se ignora en silencio
  const senderId = message?.chat.id ?? callback?.from.id;
  if (String(senderId) !== config.allowedChatId) {
    logger.warn('chat no permitido', { senderId });
    return OK;
  }

  // 3. Delegar al processor (asíncrono). Si la invocación falla, respondemos
  //    NO-200 para que Telegram reintente el webhook — antes se perdía el
  //    mensaje en silencio con un 200. El dedup del processor evita el doble
  //    proceso si la invocación en realidad sí había llegado.
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: config.processorFunctionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ update })),
      }),
    );
  } catch (err) {
    logger.error('no se pudo invocar el processor; pido reintento a Telegram', {
      updateId: update.update_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { statusCode: 500, body: 'retry' };
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
