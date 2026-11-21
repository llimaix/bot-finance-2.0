import { processUpdate } from '../lib/processing';
import type { TelegramUpdate } from '../lib/telegram';

/**
 * Worker asíncrono del bot: recibe el update que el webhook delegó y ejecuta
 * el trabajo real (agente, visión, voz, comandos) con 2 minutos de presupuesto.
 * processUpdate maneja sus propios errores (mensaje amigable al usuario);
 * cualquier excepción no manejada dispara la alarma de la Lambda.
 */
export const handler = async (event: { update: TelegramUpdate }): Promise<void> => {
  await processUpdate(event.update);
};
