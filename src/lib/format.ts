import { computeAggregates } from './aggregates';
import { DEFAULT_CATEGORY_EMOJI, SEED_CATEGORY_EMOJI } from './categories';
import type { Method, Transaction, TxnType } from './types';

/** Q1,500.00 — determinista, sin depender de la variante de ICU instalada. */
export function formatQ(amount: number): string {
  return `Q${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Emoji de un movimiento: el denormalizado al guardar → semilla → genérico. */
export function emojiFor(txn: Pick<Transaction, 'category' | 'emoji'>): string {
  return txn.emoji || SEED_CATEGORY_EMOJI[txn.category] || DEFAULT_CATEGORY_EMOJI;
}

/** Emoji de una categoría en listados agrupados, rescatándolo de los movimientos. */
export function emojiForCategory(category: string, txns?: ReadonlyArray<Transaction>): string {
  const fromTxn = txns?.find((t) => t.category === category && t.emoji)?.emoji;
  return fromTxn || SEED_CATEGORY_EMOJI[category] || DEFAULT_CATEGORY_EMOJI;
}

const METHOD_LABEL: Record<Method, string> = {
  credito: 'crédito',
  debito: 'débito',
  banrural: 'Banrural',
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  na: '',
};

const TYPE_LABEL: Record<TxnType, string> = {
  gasto: '',
  ingreso: 'Ingreso',
  retiro: 'Retiro',
  deposito: 'Depósito',
  transferencia: 'Transferencia',
};

/** Escapa lo mínimo que exige parse_mode: "HTML" de Telegram. */
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Bloque <code> (monoespaciado, copiable de un toque en Telegram) con el
 * contenido ESCAPADO. Escribir a mano "/saldo efectivo <monto>" en un mensaje
 * HTML tira el envío entero con 400 "Unsupported start tag" (incidente 29/30-jul:
 * el guardián diario no llegó durante dos días). Con este helper el placeholder
 * se escribe natural y el escapado va incluido.
 */
export function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/** "2. 🍽️ Comida — Q45.00 — efectivo" */
export function renderTxnLine(txn: Transaction): string {
  const parts = [`${emojiFor(txn)} ${escapeHtml(prefixed(txn))}`, formatQ(txn.amount)];
  const method = METHOD_LABEL[txn.method];
  if (method) parts.push(method);
  return `${txn.shortId}. ${parts.join(' — ')}`;
}

function prefixed(txn: Transaction): string {
  const label = TYPE_LABEL[txn.type];
  return label ? `${label}: ${txn.description}` : txn.description;
}

export function renderConfirmation(opts: {
  txns: Transaction[];
  /** Fecha de hoy: los movimientos retroactivos se marcan con su fecha. */
  today: string;
  totalSpentToday: number;
  /** Saldo actualizado de cada cuenta tocada ("💵 Efectivo: Q300.00"). */
  balanceLines?: string[];
  clarification: string | null;
  transcript?: string;
  header?: string;
}): string {
  const lines: string[] = [];
  if (opts.header) lines.push(opts.header, '');
  if (opts.transcript) lines.push(`🎙️ Escuché: "${escapeHtml(opts.transcript)}"`, '');
  const n = opts.txns.length;
  lines.push(`✅ Registrado (${n} ${n === 1 ? 'movimiento' : 'movimientos'}):`);
  for (const txn of opts.txns) {
    const dateSuffix = txn.date !== opts.today ? ` · 📅 ${txn.date}` : '';
    lines.push(`${renderTxnLine(txn)}${dateSuffix}`);
  }
  if (opts.balanceLines?.length) lines.push(...opts.balanceLines);
  lines.push(`Total gastado hoy: ${formatQ(opts.totalSpentToday)}`);
  if (opts.clarification) lines.push('', `❓ ${escapeHtml(opts.clarification)}`);
  // El ejemplo usa el número REAL del primer movimiento registrado: un "#2"
  // inventado manda a corregir un movimiento que no existe (incidente 13-jul).
  const ejemplo = opts.txns[0]?.shortId ?? 1;
  lines.push('', `Si algo está mal, responde: "corrige #${ejemplo} ..."`);
  return lines.join('\n');
}

/** CSV para Excel (BOM UTF-8 + CRLF), una fila por movimiento. */
export function toCsv(txns: ReadonlyArray<Transaction>): string {
  const BOM = String.fromCharCode(0xfeff);
  const esc = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const rows = [
    'fecha,tipo,categoria,metodo,monto,descripcion',
    ...[...txns]
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map((t) => [t.date, t.type, t.category, t.method, t.amount.toFixed(2), esc(t.description)].join(',')),
  ];
  return BOM + rows.join('\r\n') + '\r\n';
}

export function renderDay(date: string, txns: Transaction[]): string {
  if (txns.length === 0) return `📭 Sin movimientos registrados el ${date}.`;
  const spent = txns.filter((t) => t.type === 'gasto').reduce((acc, t) => acc + t.amount, 0);
  const lines = [`📅 Movimientos del ${date}:`, ...txns.map(renderTxnLine), '', `Total gastado: ${formatQ(spent)}`];
  return lines.join('\n');
}

export function sumSpent(txns: Transaction[]): number {
  return txns.filter((t) => t.type === 'gasto').reduce((acc, t) => acc + t.amount, 0);
}

/** Resumen de los últimos 7 días por categoría (comando /semana y resumen dominical). */
export function renderWeek(txns: Transaction[]): string {
  if (txns.length === 0) return '📭 Sin movimientos en los últimos 7 días.';
  const agg = computeAggregates(txns, 7);
  const lines = [
    '📅 <b>Últimos 7 días</b>',
    '',
    `💸 Gastos: ${formatQ(agg.totalGastos)}`,
    `📈 Promedio diario: ${formatQ(agg.dailyAverage)}`,
    '',
  ];
  const cats = Object.entries(agg.byCategory).sort(([, a], [, b]) => b.sum - a.sum);
  for (const [cat, data] of cats) {
    lines.push(`${emojiForCategory(cat, txns)} ${cat}: ${formatQ(data.sum)} (${data.count})`);
  }
  return lines.join('\n');
}
