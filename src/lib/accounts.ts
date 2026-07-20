import { formatQ } from './format';
import type { Account, AccountId, Transaction } from './types';

export const DEFAULT_ACCOUNTS: Array<Pick<Account, 'id' | 'name' | 'emoji'>> = [
  { id: 'banco', name: 'Banco Industrial (BI)', emoji: '🏦' },
  { id: 'banrural', name: 'Banrural', emoji: '🌾' },
  { id: 'tarjeta', name: 'Tarjeta BAC', emoji: '💳' },
  { id: 'efectivo', name: 'Efectivo', emoji: '💵' },
  { id: 'kash', name: 'Kash', emoji: '📱' },
];

/**
 * Efecto de un movimiento sobre una cuenta (0 si no la toca).
 * Pura y testeable: es el corazón del modelo de saldos.
 *
 * Supuestos documentados:
 * - Los ingresos (salarios, bonos) entran al banco.
 * - method=debito sale del banco; method=credito sube la deuda de la tarjeta.
 * - Los retiros (débito o crédito) convierten a efectivo.
 * - transferencia+method transferencia = banco → Kash.
 * - transferencia categoría deuda con débito = pago de tarjeta (banco → tarjeta).
 * - Depósitos (p.ej. a ahorro) salen del banco salvo que sean en efectivo.
 */
export function accountDelta(txn: Transaction, account: AccountId): number {
  const a = txn.amount;
  switch (account) {
    case 'banco':
      // Ingresos NO en efectivo entran al banco; un ingreso en efectivo ya lo
      // suma la cuenta efectivo (contarlo aquí también lo duplicaba en el neto).
      if (txn.type === 'ingreso' && txn.method !== 'efectivo') return a;
      if (txn.method === 'debito') return -a;
      // Sale del banco: transferencia a Kash o pago de tarjeta (categoría deuda).
      if (txn.type === 'transferencia' && (txn.method === 'transferencia' || txn.category === 'deuda')) return -a;
      if (txn.type === 'deposito' && txn.method !== 'efectivo') return -a;
      return 0;

    case 'banrural':
      // Cuenta secundaria casi estática: se ajusta por semilla (/saldo o el agente),
      // los movimientos con débito se atribuyen a la cuenta principal (BI).
      return 0;

    case 'tarjeta':
      if (txn.method === 'credito') return -a;
      // Pago de tarjeta (baja la deuda): transferencia categoría deuda, sea el
      // método débito o transferencia — antes solo débito y el resto iba a Kash.
      if (txn.type === 'transferencia' && txn.category === 'deuda') return a;
      return 0;

    case 'efectivo':
      if (txn.type === 'retiro') return a;
      if (txn.method === 'efectivo') return txn.type === 'ingreso' ? a : -a;
      return 0;

    case 'kash':
      // Transferencia a Kash, EXCEPTO si es un pago de tarjeta (categoría deuda).
      if (txn.type === 'transferencia' && txn.method === 'transferencia' && txn.category !== 'deuda') return a;
      if (txn.type === 'gasto' && txn.method === 'transferencia') return -a;
      return 0;
  }
}

export interface AccountBalance extends Account {
  balance: number;
  /** Movimientos posteriores a asOf que participaron en el cálculo. */
  movements: number;
}

/**
 * Saldo actual de cada cuenta: semilla + deltas de los movimientos con fecha
 * estrictamente posterior al asOf de esa cuenta.
 */
export function computeBalances(
  accounts: ReadonlyArray<Account>,
  txns: ReadonlyArray<Transaction>,
): AccountBalance[] {
  return accounts.map((acc) => {
    let balance = acc.seedBalance;
    let movements = 0;
    for (const txn of txns) {
      if (txn.date <= acc.asOf) continue;
      const delta = accountDelta(txn, acc.id);
      if (delta !== 0) {
        balance = Math.round((balance + delta) * 100) / 100;
        movements += 1;
      }
    }
    return { ...acc, balance, movements };
  });
}

export function renderSaldos(balances: ReadonlyArray<AccountBalance>): string {
  const lines = ['💰 <b>Tus saldos</b>', ''];
  let neto = 0;
  for (const b of balances) {
    neto = Math.round((neto + b.balance) * 100) / 100;
    const flag = b.estimated ? ' ⚠️ estimado' : '';
    // "(al <fecha> + N movs)" confundía: parecía decir "sin movimientos desde
    // <fecha>" cuando significa lo contrario (base anclada + N ya aplicados).
    const detalle =
      b.movements > 0
        ? `incluye tu${b.movements === 1 ? ' último movimiento' : `s últimos ${b.movements} movimientos`}`
        : `sin movimientos desde el ${b.asOf}`;
    lines.push(`${b.emoji} ${b.name}: ${formatQ(b.balance)}${flag}  <i>(${detalle})</i>`);
  }
  lines.push('', `🧮 Neto líquido: ${formatQ(neto)}`);
  lines.push(
    '',
    'ℹ️ Cada saldo = base confirmada en su última cuadratura + tus movimientos posteriores, ya sumados.',
    'Ajusta una base con: /saldo efectivo 350',
  );
  return lines.join('\n');
}
