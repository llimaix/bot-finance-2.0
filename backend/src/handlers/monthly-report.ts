import { config } from '../lib/config';
import { daysInMonth, monthLabelES, monthPrefixGT } from '../lib/dates';
import { queryMonth } from '../lib/dynamo';
import { logger } from '../lib/logger';
import { buildReport } from '../lib/report';
import { loadSecrets } from '../lib/secrets';
import { sendMessage } from '../lib/telegram';

/** Día 1 de cada mes, 08:00 GT: reporte completo del mes que acaba de cerrar. */
export const handler = async (): Promise<void> => {
  await loadSecrets();
  const month = monthPrefixGT(-1);
  const prevMonth = monthPrefixGT(-2);

  const [txns, prevTxns] = await Promise.all([queryMonth(month), queryMonth(prevMonth)]);
  logger.info('generando reporte mensual', { month, txns: txns.length, prevTxns: prevTxns.length });

  const report = await buildReport({
    periodLabel: monthLabelES(month),
    txns,
    prevTxns,
    daysInPeriod: daysInMonth(month),
    includeNarrative: true,
  });

  await sendMessage(config.allowedChatId, report);
  logger.info('reporte mensual enviado', { month });
};
