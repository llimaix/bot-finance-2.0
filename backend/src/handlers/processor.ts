import type { Context } from 'aws-lambda';
import { setDeadline } from '../lib/deadline';
import { logger } from '../lib/logger';
import { processUpdate } from '../lib/processing';
import { loadSecrets } from '../lib/secrets';
import { sendMessage } from '../lib/telegram';
import type { TelegramUpdate } from '../lib/telegram';

/** Margen que las fases largas dejan libre para confirmar al usuario y escribir. */
const RESERVE_MS = 15_000;
/** Si a esta distancia del timeout no ha terminado, se avisa al usuario. */
const WATCHDOG_MS = 8_000;

const TIMEOUT_NOTICE =
  '⏳ Me quedé sin tiempo procesando tu mensaje. Revisa /hoy antes de reenviarlo: puede que una parte sí se haya guardado.';

/**
 * Worker asíncrono del bot: recibe el update que el webhook delegó y ejecuta
 * el trabajo real (agente, visión, voz, comandos) con el presupuesto de la Lambda.
 * processUpdate maneja sus propios errores (mensaje amigable al usuario);
 * cualquier excepción no manejada dispara la alarma de la Lambda.
 */
export const handler = async (event: { update: TelegramUpdate }, context: Context): Promise<void> => {
  await loadSecrets();

  const remaining = context.getRemainingTimeInMillis();
  setDeadline(Date.now() + remaining - RESERVE_MS);

  // Watchdog (M5): si Lambda corta por timeout, el catch de processUpdate no
  // corre y el usuario no se entera. Avisamos antes del corte.
  let finished = false;
  const watchdog = setTimeout(
    () => {
      if (!finished) void warnTimeout(event.update);
    },
    Math.max(0, remaining - WATCHDOG_MS),
  );

  try {
    await processUpdate(event.update);
  } finally {
    finished = true;
    clearTimeout(watchdog);
    setDeadline(undefined);
  }
};

async function warnTimeout(update: TelegramUpdate): Promise<void> {
  logger.warn('processor sin tiempo: aviso al usuario', { updateId: update.update_id });
  const chatId = update.message?.chat.id ?? update.callback_query?.from.id;
  if (!chatId) return;
  await sendMessage(chatId, TIMEOUT_NOTICE).catch((err) =>
    logger.error('no se pudo enviar el aviso de tiempo', { error: String(err) }),
  );
}
