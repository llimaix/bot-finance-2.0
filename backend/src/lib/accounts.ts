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
 * - Los depósitos son el INVERSO del retiro: entran a la cuenta, y si son en
 *   efectivo salen del efectivo (billetes que llevas al banco).
 * - transferencia+method transferencia = banco → Kash.
 * - transferencia categoría deuda = pago de tarjeta (banco → tarjeta), con el
 *   método que venga: un pago NUNCA sube la deuda.
 * - method=banrural es el "banco" de Banrural: todo lo que el banco haría con
 *   ese movimiento lo hace Banrural, y BI no se entera.
 */
export function accountDelta(txn: Transaction, account: AccountId): number {
  const a = txn.amount;
  switch (account) {
    case 'banco':
      // Movimiento de Banrural: BI no lo ve (incidente 1-oct: el bono depositado
      // a Banrural sumó a BI porque el ingreso entraba al banco "por defecto").
      if (txn.method === 'banrural') return 0;
      // Ingresos NO en efectivo entran al banco; un ingreso en efectivo ya lo
      // suma la cuenta efectivo (contarlo aquí también lo duplicaba en el neto).
      if (txn.type === 'ingreso' && txn.method !== 'efectivo') return a;
      // Depósito = ENTRA a la cuenta (par simétrico del retiro). Va ANTES de la
      // regla de débito: si no, un depósito con method=debito se resta —
      // incidente 31-jul, Q7,064.79 de planilla y bono restados de BI en vez
      // de sumados, dejando la cuenta en Q-6,335.90.
      if (txn.type === 'deposito') return a;
      if (txn.method === 'debito') return -a;
      // Sale del banco: transferencia a Kash o pago de tarjeta (categoría deuda).
      if (txn.type === 'transferencia' && (txn.method === 'transferencia' || txn.category === 'deuda')) return -a;
      return 0;

    case 'banrural':
      // Solo lo que viene marcado banrural; un debito sin más sigue siendo BI.
      if (txn.method !== 'banrural') return 0;
      if (txn.type === 'ingreso' || txn.type === 'deposito') return a;
      // Gasto, retiro (pasa a efectivo), transferencia o pago de tarjeta: sale.
      return -a;

    case 'tarjeta':
      // Pago de tarjeta (BAJA la deuda): transferencia categoría deuda, con el
      // método que venga. Va ANTES de la regla de crédito: si no, un pago que
      // llega etiquetado credito SUBE la deuda — incidente 3-sep, los
      // Q4,831.78 del cierre BAC sumados en vez de restados.
      if (txn.type === 'transferencia' && txn.category === 'deuda') return a;
      if (txn.method === 'credito') return -a;
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
  /** Modelo v2: deuda de largo plazo. Su saldo es negativo y no es liquidez. */
  prestamo?: boolean;
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

/**
 * Una línea por cada cuenta que tocaron los movimientos recién registrados,
 * con su saldo ya actualizado: "💵 Efectivo: Q300.00". Sin desglose — el
 * detalle completo vive en /saldo.
 */
export function renderAffectedBalances(
  txns: ReadonlyArray<Transaction>,
  balances: ReadonlyArray<AccountBalance>,
): string[] {
  return balances
    .filter((b) => txns.some((t) => accountDelta(t, b.id) !== 0))
    .map((b) => `${b.emoji} ${b.name}: ${formatQ(b.balance)}`);
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
