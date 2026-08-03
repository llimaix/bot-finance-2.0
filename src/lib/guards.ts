import { formatQ } from './format';
import type { Method, Transaction } from './types';

/**
 * La cuenta que el mensaje nombra sin lugar a dudas. El prompt ya lo explica,
 * pero un prompt es una probabilidad: "tarjeta BI" —la misma frase, escrita
 * igual— salió credito 2 de 4 veces y debito las otras 2, según qué ruta
 * atendiera el mensaje (incidente 31-jul/2-ago). Cuando Allan NOMBRA la
 * cuenta, el método deja de ser opinión del modelo.
 *
 * Devuelve null si el texto no nombra ninguna cuenta o si nombra VARIAS: en
 * "retiré 1000 de BI y pasan a efectivo" hay dos señales legítimas y solo el
 * modelo, que ve cada movimiento por separado, puede repartirlas.
 */
const ACCOUNT_SIGNALS: ReadonlyArray<{ re: RegExp; method: Method }> = [
  // La tarjeta del BI es de DÉBITO: es la trampa que originó el incidente.
  { re: /\b(bi|banco industrial)\b/, method: 'debito' },
  { re: /\bbac\b/, method: 'credito' },
  { re: /\bcredito\b|\btarjeta de credito\b/, method: 'credito' },
  { re: /\bbanrural\b/, method: 'debito' },
  { re: /\bkash\b/, method: 'transferencia' },
  { re: /\befectivo\b|\bbilletes\b/, method: 'efectivo' },
];

export function statedMethod(text: string): Method | null {
  const t = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const hits = new Set(ACCOUNT_SIGNALS.filter((s) => s.re.test(t)).map((s) => s.method));
  return hits.size === 1 ? [...hits][0]! : null;
}

/**
 * Impone el método que el mensaje dice, por encima del que eligió el modelo.
 * Devuelve los movimientos corregidos y una nota por cada cambio: corregir un
 * saldo en silencio es peor que no corregirlo, porque Allan no puede auditarlo.
 */
export function enforceStatedMethod<T extends { method: Method; description: string }>(
  txns: ReadonlyArray<T>,
  text: string,
): { txns: T[]; corrections: string[] } {
  const stated = statedMethod(text);
  if (!stated) return { txns: [...txns], corrections: [] };

  const corrections: string[] = [];
  const fixed = txns.map((t) => {
    if (t.method === stated) return t;
    corrections.push(`«${t.description}»: ${t.method} → ${stated}`);
    return { ...t, method: stated };
  });
  return { txns: fixed, corrections };
}

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
