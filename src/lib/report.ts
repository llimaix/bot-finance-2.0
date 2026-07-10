import { narrateReport } from './ai/parse';
import { computeAggregates } from './aggregates';
import type { Aggregates } from './aggregates';
import { CATEGORY_EMOJI, escapeHtml, formatQ } from './format';
import { logger } from './logger';
import type { Category, Transaction } from './types';

export interface ReportOptions {
  /** Etiqueta legible del período, p.ej. "junio de 2026" o "julio de 2026 (al día 10)". */
  periodLabel: string;
  txns: Transaction[];
  prevTxns: Transaction[];
  /** Divisor del promedio diario: días del mes cerrado o días transcurridos. */
  daysInPeriod: number;
  /** El comando /reporte y el reporte automático incluyen narrativa del LLM. */
  includeNarrative: boolean;
}

/**
 * Reporte compartido entre la Lambda monthly-report (mes anterior) y el
 * comando /reporte (mes en curso). Números calculados en código; el LLM narra.
 */
export async function buildReport(opts: ReportOptions): Promise<string> {
  if (opts.txns.length === 0) {
    return `📊 No hubo movimientos registrados en ${escapeHtml(opts.periodLabel)}.`;
  }

  const agg = computeAggregates(opts.txns, opts.daysInPeriod, opts.prevTxns);
  const lines: string[] = [`📊 <b>Reporte — ${escapeHtml(opts.periodLabel)}</b>`, ''];

  lines.push(`💸 Gastos: ${formatQ(agg.totalGastos)}`);
  if (agg.totalIngresos > 0) lines.push(`💰 Ingresos: ${formatQ(agg.totalIngresos)}`);
  if (agg.totalAhorro > 0) lines.push(`🐷 Ahorro: ${formatQ(agg.totalAhorro)}`);
  lines.push(`📈 Promedio diario de gasto: ${formatQ(agg.dailyAverage)}`);
  if (agg.comparison) {
    const delta =
      agg.comparison.deltaPct === null
        ? ''
        : ` (${agg.comparison.deltaPct > 0 ? '+' : ''}${agg.comparison.deltaPct}%)`;
    lines.push(`🔁 Mes anterior: ${formatQ(agg.comparison.prevTotalGastos)}${delta}`);
  }

  lines.push('', '<b>Por categoría:</b>');
  const cats = Object.entries(agg.byCategory).sort(([, a], [, b]) => b.sum - a.sum);
  for (const [cat, data] of cats) {
    lines.push(`${CATEGORY_EMOJI[cat as Category]} ${cat}: ${formatQ(data.sum)} (${data.count})`);
  }

  lines.push('', '<b>Por método de pago:</b>');
  for (const [method, sum] of Object.entries(agg.byMethod).sort(([, a], [, b]) => b - a)) {
    lines.push(`• ${method === 'na' ? 'otro' : method}: ${formatQ(sum)}`);
  }

  if (agg.top5.length > 0) {
    lines.push('', '<b>Top gastos:</b>');
    agg.top5.forEach((t, i) => {
      lines.push(`${i + 1}. ${escapeHtml(t.description)} — ${formatQ(t.amount)}`);
    });
  }

  lines.push(
    '',
    `🐜 Gastos hormiga (≤ ${formatQ(agg.hormiga.threshold)}): ${agg.hormiga.count} por ${formatQ(agg.hormiga.sum)}`,
  );

  if (opts.includeNarrative) {
    const narrative = await safeNarrate(agg, opts.periodLabel);
    if (narrative) lines.push('', '🧠 <b>Análisis:</b>', escapeHtml(narrative));
  }

  return lines.join('\n');
}

/** La narrativa es un extra: si el LLM falla, el reporte numérico sale igual. */
async function safeNarrate(agg: Aggregates, periodLabel: string): Promise<string | null> {
  try {
    return await narrateReport({ periodo: periodLabel, ...agg });
  } catch (err) {
    logger.error('narrativa del reporte falló', { error: String(err) });
    return null;
  }
}
