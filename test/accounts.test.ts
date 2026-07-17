import { describe, expect, it } from 'vitest';
import { accountDelta, computeBalances } from '../src/lib/accounts';
import type { Account, Transaction } from '../src/lib/types';

let n = 0;
function txn(partial: Partial<Transaction>): Transaction {
  n += 1;
  return {
    sk: `TXN#2026-07-11#t${n}`,
    date: '2026-07-11',
    shortId: n,
    amount: 100,
    type: 'gasto',
    category: 'otros',
    method: 'debito',
    description: `mov ${n}`,
    rawMessage: '',
    createdAt: '2026-07-11T12:00:00Z',
    ...partial,
  };
}

const account = (id: Account['id'], seedBalance: number, asOf = '2026-07-10'): Account => ({
  id,
  name: id,
  emoji: '💰',
  seedBalance,
  asOf,
  estimated: false,
  updatedAt: '',
});

describe('accountDelta', () => {
  it('gasto con débito sale del banco; con crédito sube deuda de tarjeta', () => {
    const debito = txn({ method: 'debito', amount: 50 });
    expect(accountDelta(debito, 'banco')).toBe(-50);
    expect(accountDelta(debito, 'tarjeta')).toBe(0);

    const credito = txn({ method: 'credito', amount: 80 });
    expect(accountDelta(credito, 'tarjeta')).toBe(-80);
    expect(accountDelta(credito, 'banco')).toBe(0);
  });

  it('ingreso entra al banco', () => {
    const salario = txn({ type: 'ingreso', method: 'na', amount: 7500 });
    expect(accountDelta(salario, 'banco')).toBe(7500);
    expect(accountDelta(salario, 'efectivo')).toBe(0);
  });

  it('retiro: sale del banco (o tarjeta) y entra a efectivo', () => {
    const atm = txn({ type: 'retiro', method: 'debito', amount: 500 });
    expect(accountDelta(atm, 'banco')).toBe(-500);
    expect(accountDelta(atm, 'efectivo')).toBe(500);

    const adelantoTC = txn({ type: 'retiro', method: 'credito', amount: 300 });
    expect(accountDelta(adelantoTC, 'tarjeta')).toBe(-300);
    expect(accountDelta(adelantoTC, 'efectivo')).toBe(300);
  });

  it('gasto en efectivo baja el efectivo, no el banco', () => {
    const cash = txn({ method: 'efectivo', amount: 45 });
    expect(accountDelta(cash, 'efectivo')).toBe(-45);
    expect(accountDelta(cash, 'banco')).toBe(0);
  });

  it('transferencia a Kash: banco → kash', () => {
    const kash = txn({ type: 'transferencia', method: 'transferencia', amount: 2000, category: 'otros' });
    expect(accountDelta(kash, 'banco')).toBe(-2000);
    expect(accountDelta(kash, 'kash')).toBe(2000);
    expect(accountDelta(kash, 'tarjeta')).toBe(0);
  });

  it('pago de tarjeta: banco → tarjeta (baja la deuda)', () => {
    const pago = txn({ type: 'transferencia', method: 'debito', category: 'deuda', amount: 2000 });
    expect(accountDelta(pago, 'banco')).toBe(-2000);
    expect(accountDelta(pago, 'tarjeta')).toBe(2000);
  });
});

describe('computeBalances', () => {
  it('semilla + solo movimientos posteriores al asOf', () => {
    const accounts = [account('banco', 4101.01, '2026-07-10')];
    const txns = [
      txn({ date: '2026-07-10', method: 'debito', amount: 999 }), // = asOf → excluido
      txn({ date: '2026-07-11', method: 'debito', amount: 100 }),
      txn({ date: '2026-07-11', type: 'ingreso', method: 'na', amount: 50 }),
    ];
    const [banco] = computeBalances(accounts, txns);
    expect(banco!.balance).toBe(4051.01);
    expect(banco!.movements).toBe(2);
  });

  it('la deuda de tarjeta baja con pagos y sube con compras', () => {
    const accounts = [account('tarjeta', -4092.86, '2026-07-10')];
    const txns = [
      txn({ date: '2026-07-11', method: 'credito', amount: 100 }),
      txn({ date: '2026-07-12', type: 'transferencia', method: 'debito', category: 'deuda', amount: 1000 }),
    ];
    const [tarjeta] = computeBalances(accounts, txns);
    expect(tarjeta!.balance).toBe(-3192.86);
  });
});

describe('renderSaldos', () => {
  it('explica el modelo sin jerga: movimientos incluidos, no fecha críptica', async () => {
    const { renderSaldos } = await import('../src/lib/accounts');
    const text = renderSaldos([
      { id: 'banco', name: 'Banco Industrial (BI)', emoji: '🏦', seedBalance: 915, asOf: '2026-07-12', estimated: false, updatedAt: '', balance: 3190.59, movements: 3 },
      { id: 'efectivo', name: 'Efectivo', emoji: '💵', seedBalance: 0, asOf: '2026-07-15', estimated: false, updatedAt: '', balance: 0, movements: 0 },
    ]);
    expect(text).toContain('incluye tus últimos 3 movimientos');
    expect(text).toContain('sin movimientos desde el 2026-07-15');
    expect(text).not.toContain('+ 3 movs'); // la notación críptica no vuelve
    expect(text).toContain('base confirmada');
  });
});
