import { config } from '../lib/config';
import { todayGT } from '../lib/dates';
import { getDayState } from '../lib/dynamo';
import { logger } from '../lib/logger';
import { sendMessage } from '../lib/telegram';
import type { ScheduleEvent } from '../lib/types';

const PRIMARY_MESSAGE =
  '🕔 ¿Qué movimientos hubo hoy? Cuéntame: compras con crédito, débito, efectivo, retiros o depósitos. Puedes mandar texto o audio.';

const FOLLOWUP_MESSAGE =
  '🌙 Recordatorio: aún no registras movimientos hoy. ¿Hubo alguno? Si no hubo nada, respóndeme "hoy nada".';

export const handler = async (event: ScheduleEvent): Promise<void> => {
  const today = todayGT();

  if (event.kind === 'followup') {
    const day = await getDayState(today);
    if (day.reported) {
      logger.info('seguimiento omitido: el día ya fue reportado', { date: today });
      return;
    }
    await sendMessage(config.allowedChatId, FOLLOWUP_MESSAGE);
    logger.info('seguimiento enviado', { date: today });
    return;
  }

  await sendMessage(config.allowedChatId, PRIMARY_MESSAGE);
  logger.info('recordatorio enviado', { date: today, kind: event.kind });
};
