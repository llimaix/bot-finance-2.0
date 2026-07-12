import { formatQ } from './format';
import type { Transaction } from './types';

/** Aviso de montos inusualmente grandes (posible dedazo o mala transcripción). */
const BIG_AMOUNT_THRESHOLD = 10_000;

/**
 * Escudos al registrar: detecta posibles duplicados (misma fecha + monto +
 * categoría que un movimiento ya existente) y montos sospechosamente grandes.
 * Devuelve advertencias para anexar a la respuesta — nunca bloquea el registro
 * (el botón 🗑️ queda a un toque si era duplicado).
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
        e.category === txn.category,
    );
    if (dup) {
      warnings.push(
        `⚠️ Posible duplicado: #${txn.shortId} coincide con #${dup.shortId} (${dup.description}, ${formatQ(dup.amount)} el ${dup.date}). Si es el mismo, borra uno con 🗑️.`,
      );
    }
    if (txn.amount >= BIG_AMOUNT_THRESHOLD) {
      warnings.push(`👀 Monto grande en #${txn.shortId}: ${formatQ(txn.amount)}. ¿Es correcto?`);
    }
  }

  return warnings;
}
