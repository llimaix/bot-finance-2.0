import { coachNarrative } from '../lib/ai/parse';
import { config } from '../lib/config';
import { addDaysTo, daysAgoGT, daysInMonth, monthPrefixGT, nextPaydayAfter, todayGT } from '../lib/dates';
import { getDayState, queryRange } from '../lib/dynamo';
import { escapeHtml, formatQ, renderWeek } from '../lib/format';
import { guardianFindings, loadAdvisorData, paydayCoachInput, weeklyCoachInput } from '../lib/insights';
import { logger } from '../lib/logger';
import { loadProfile } from '../lib/profile';
import { loadSecrets } from '../lib/secrets';
import { sendMessage } from '../lib/telegram';
import { alertasTarjetas, loadCiclos } from '../lib/v2/tarjetas';
import type { ScheduleEvent } from '../lib/types';

const PRIMARY_MESSAGE =
  '🕔 ¿Qué movimientos hubo hoy? Cuéntame: compras con crédito, débito, efectivo, retiros o depósitos. Puedes mandar texto o audio.';

const FOLLOWUP_MESSAGE =
  '🌙 Recordatorio: aún no registras movimientos hoy. ¿Hubo alguno? Si no hubo nada, respóndeme "hoy nada".';

export const handler = async (event: ScheduleEvent): Promise<void> => {
  await loadSecrets();
  await loadProfile();
  const today = todayGT();

  if (event.kind === 'guardian') {
    // Vigilancia diaria con reglas deterministas: solo habla si hay hallazgos.
    const data = await loadAdvisorData(today, daysInMonth(monthPrefixGT(0)));
    const findings = guardianFindings(data);
    // Modelo v2: avisos de corte, pago, vencimiento y uso del límite por tarjeta.
    if (config.accountsModel === 'v2') findings.push(...alertasTarjetas((await loadCiclos(today)).tarjetas, today));
    if (findings.length === 0) {
      logger.info('guardián sin hallazgos', { date: today });
      return;
    }
    await sendMessage(config.allowedChatId, `🛡️ <b>Guardián financiero</b>\n\n${findings.join('\n\n')}`);
    logger.info('guardián con hallazgos', { date: today, findings: findings.length });
    return;
  }

  if (event.kind === 'weekly') {
    const [data, prevWeekTxns] = await Promise.all([
      loadAdvisorData(today, daysInMonth(monthPrefixGT(0))),
      queryRange(daysAgoGT(13), daysAgoGT(7)),
    ]);
    // El coach redacta sobre números ya calculados; si el LLM falla, el
    // resumen sale igual (solo sin consejo) — nunca se pierde el mensaje.
    const advice = await coachNarrative('weekly', weeklyCoachInput(data, prevWeekTxns)).catch((err) => {
      logger.error('coach semanal falló', { error: String(err) });
      return null;
    });
    const parts = ['📊 <b>Resumen semanal</b>', '', renderWeek(data.weekTxns)];
    if (advice) parts.push('', '🧭 <b>Tu coach</b>', escapeHtml(advice));
    parts.push('', '🧮 ¿Cuadramos? Dime cuánto efectivo real llevas y cuánto tienes en Kash para afinar tus saldos.');
    await sendMessage(config.allowedChatId, parts.join('\n'));
    logger.info('resumen semanal enviado', { date: today, txns: data.weekTxns.length, coach: advice !== null });
    return;
  }

  if (event.kind === 'payday') {
    // Corre a diario; solo habla si MAÑANA es día de pago real (15 o fin de
    // mes, retrocedido a día hábil cuando cae en fin de semana).
    const payday = nextPaydayAfter(today);
    if (payday !== addDaysTo(today, 1)) {
      logger.info('checkpoint de quincena omitido: mañana no es día de pago', { date: today, proximoPago: payday });
      return;
    }
    const data = await loadAdvisorData(today, daysInMonth(monthPrefixGT(0)));
    const input = paydayCoachInput(data);
    const advice = await coachNarrative('payday', input).catch((err) => {
      logger.error('coach de quincena falló', { error: String(err) });
      return null;
    });
    // Fallback determinista: los números clave llegan aunque el LLM falle.
    const body =
      advice !== null
        ? escapeHtml(advice)
        : [
            `Compromisos que aún vienen este mes: ${formatQ(input.compromisosPendientes.total)}.`,
            `Colchón de gasto variable (${input.colchonGastoVariable.dias} días): ${formatQ(input.colchonGastoVariable.total)}.`,
            `Sugerencia: al caer tu pago, aparta ${formatQ(input.sugerenciaApartarAlCaer)}. Detalle en /proyeccion y /metas.`,
          ].join('\n');
    await sendMessage(config.allowedChatId, `💰 <b>Plan de quincena</b>\n\n${body}`);
    logger.info('checkpoint de quincena enviado', { date: today, coach: advice !== null });
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
