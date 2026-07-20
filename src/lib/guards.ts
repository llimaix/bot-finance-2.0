import { formatQ } from './format';
import type { Transaction } from './types';

/** Aviso de montos inusualmente grandes (posible dedazo o mala transcripción). */
const BIG_AMOUNT_THRESHOLD = 10_000;

const STOPWORDS = new Set(['con', 'para', 'por', 'del', 'los', 'las', 'una', 'unos', 'unas', 'que', 'mis']);

/** Tokens de una descripción, sin tildes ni ruido, para comparar conceptos. */
function descTokens(desc: string): Set<string> {
  return new Set(
    desc
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Similitud Jaccard entre descripciones (0-1). */
function descSimilarity(a: string, b: string): number {
  const ta = descTokens(a);
  const tb = descTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Escudos al registrar: detecta posibles duplicados y montos sospechosos.
 * Un duplicado es misma fecha + mismo monto + (misma categoría O descripción
 * similar) — la categoría sola no basta: el incidente del 11-jul duplicó un
 * préstamo cambiándole la categoría (deuda → prestamo). Devuelve advertencias
 * para anexar a la respuesta — nunca bloquea el registro (el botón 🗑️ queda
 * a un toque si era duplicado).
 */
export function registrationWarnings(
  newTxns: ReadonlyArray<Transaction>,
  existing: ReadonlyArray<Transaction>,
): string[] {
  const warnings: string[] = [];
  const newSks = new Set(newTxns.map((t) => t.sk));

  for (const txn of newTxns) {
    const dup = existing.find(
      (e) =>
        !newSks.has(e.sk) &&
        e.date === txn.date &&
        e.amount === txn.amount &&
        (e.category === txn.category || descSimilarity(e.description, txn.description) >= 0.5),
    );
    if (dup) {
      warnings.push(
        `⚠️ Posible duplicado: #${txn.shortId} coincide con #${dup.shortId} (${dup.description}, ${formatQ(dup.amount)} el ${dup.date}). Si es el mismo, borra uno con 🗑️.`,
      );
    }
    if (txn.amount >= BIG_AMOUNT_THRESHOLD) {
      warnings.push(`👀 Monto grande en #${txn.shortId}: ${formatQ(txn.amount)}. ¿Es correcto?`);
    }
    // Un gasto/retiro SIN cuenta (method 'na') no afecta ningún saldo pero sí
    // cuenta como gasto → infla el neto. No adivinamos la cuenta: preguntamos.
    if ((txn.type === 'gasto' || txn.type === 'retiro') && txn.method === 'na') {
      warnings.push(
        `❓ #${txn.shortId} (${txn.description}) quedó SIN cuenta asignada, así que no está afectando tus saldos. ¿De dónde salió: crédito, débito o efectivo? Dímelo y lo corrijo.`,
      );
    }
  }

  return warnings;
}
