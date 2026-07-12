import { config } from '../lib/config';
import { daysAgoGT, daysInMonth, monthPrefixGT, todayGT } from '../lib/dates';
import { getDayState, queryRange } from '../lib/dynamo';
import { renderWeek } from '../lib/format';
import { guardianFindings, loadAdvisorData } from '../lib/insights';
import { logger } from '../lib/logger';
import { sendMessage } from '../lib/telegram';
import type { ScheduleEvent } from '../lib/types';

const PRIMARY_MESSAGE =
  '🕔 ¿Qué movimientos hubo hoy? Cuéntame: compras con crédito, débito, efectivo, retiros o depósitos. Puedes mandar texto o audio.';

const FOLLOWUP_MESSAGE =
  '🌙 Recordatorio: aún no registras movimientos hoy. ¿Hubo alguno? Si no hubo nada, respóndeme "hoy nada".';

export const handler = async (event: ScheduleEvent): Promise<void> => {
  const today = todayGT();

  if (event.kind === 'guardian') {
    // Vigilancia diaria con reglas deterministas: solo habla si hay hallazgos.
    const data = await loadAdvisorData(today, daysInMonth(monthPrefixGT(0)));
    const findings = guardianFindings(data);
    if (findings.length === 0) {
      logger.info('guardián sin hallazgos', { date: today });
      return;
    }
    await sendMessage(config.allowedChatId, `🛡️ <b>Guardián financiero</b>\n\n${findings.join('\n\n')}`);
    logger.info('guardián con hallazgos', { date: today, findings: findings.length });
    return;
  }

  if (event.kind === 'weekly') {
    const txns = await queryRange(daysAgoGT(6), today);
    const reconciliation =
      '🧮 ¿Cuadramos? Dime cuánto efectivo real llevas y cuánto tienes en Kash para afinar tus saldos.';
    await sendMessage(config.allowedChatId, `📊 <b>Resumen semanal</b>\n\n${renderWeek(txns)}\n\n${reconciliation}`);
    logger.info('resumen semanal enviado', { date: today, txns: txns.length });
    return;
  }

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
