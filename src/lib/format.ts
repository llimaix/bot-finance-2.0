import type { Category, Method, Transaction, TxnType } from './types';

/** Q1,500.00 — determinista, sin depender de la variante de ICU instalada. */
export function formatQ(amount: number): string {
  return `Q${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const CATEGORY_EMOJI: Record<Category, string> = {
  comida: '🍽️',
  supermercado: '🛒',
  transporte: '🚗',
  hogar: '🏠',
  herramientas: '🔧',
  construccion: '🧱',
  salud: '💊',
  educacion: '📚',
  entretenimiento: '🎬',
  ropa: '👕',
  regalos: '🎁',
  servicios: '💡',
  suscripciones: '📺',
  ahorro: '🐷',
  inversion: '📈',
  deuda: '💳',
  otros: '📦',
};

const METHOD_LABEL: Record<Method, string> = {
  credito: 'crédito',
  debito: 'débito',
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

/** "2. 🍽️ Comida — Q45.00 — efectivo" */
export function renderTxnLine(txn: Transaction): string {
  const parts = [`${CATEGORY_EMOJI[txn.category]} ${escapeHtml(prefixed(txn))}`, formatQ(txn.amount)];
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
  totalSpentToday: number;
  clarification: string | null;
  transcript?: string;
}): string {
  const lines: string[] = [];
  if (opts.transcript) lines.push(`🎙️ Escuché: "${escapeHtml(opts.transcript)}"`, '');
  const n = opts.txns.length;
  lines.push(`✅ Registrado (${n} ${n === 1 ? 'movimiento' : 'movimientos'}):`);
  for (const txn of opts.txns) lines.push(renderTxnLine(txn));
  lines.push(`Total gastado hoy: ${formatQ(opts.totalSpentToday)}`);
  if (opts.clarification) lines.push('', `❓ ${escapeHtml(opts.clarification)}`);
  lines.push('', 'Si algo está mal, responde: "corrige #2 ..."');
  return lines.join('\n');
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
