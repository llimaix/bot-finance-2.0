import { describe, expect, it } from 'vitest';
import { isVisibleInModel } from '../src/lib/dynamo';
import type { Transaction, TransactionV2 } from '../src/lib/types';
import { saldos } from '../src/lib/v2/balance';
import { legacyFields, toMovimientos } from '../src/lib/v2/legacy';
import type { Cuenta } from '../src/lib/v2/model';

const cuenta = (id: string, tipo: Cuenta['tipo'], semillaCentavos = 0): Cuenta => ({
  id,
  nombre: id,
  tipo,
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...(tipo === 'credito'
    ? { credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'siguiente_habil' as const, diasAviso: [] } }
    : {}),
});

const CUENTAS = [cuenta('bi', 'banco', 500_000), cuenta('visa', 'credito', -100_000), cuenta('efectivo', 'efectivo'), cuenta('kash', 'billetera')];

const v2 = (over: Partial<TransactionV2>): TransactionV2 => ({
  montoCentavos: 4_550,
  tipo: 'gasto',
  origen: 'bi',
  destino: null,
  cuentaFuente: 'alias',
  ...over,
});

const txn = (over: Partial<Transaction>): Transaction => ({
  sk: 'TXN#2026-11-22#01',
  date: '2026-11-22',
  shortId: 1,
  amount: 45.5,
  type: 'gasto',
  category: 'comida',
  method: 'debito',
  description: 'almuerzo',
  rawMessage: 'almuerzo',
  createdAt: '2026-11-22T12:00:00Z',
  ...over,
});

describe('campos v1 derivados del modelo v2', () => {
  it('gasto: el monto en quetzales y el método según la cuenta de origen', () => {
    expect(legacyFields(v2({ origen: 'bi' }), CUENTAS)).toEqual({ amount: 45.5, type: 'gasto', method: 'debito' });
    expect(legacyFields(v2({ origen: 'visa' }), CUENTAS)).toMatchObject({ method: 'credito' });
    expect(legacyFields(v2({ origen: 'efectivo' }), CUENTAS)).toMatchObject({ method: 'efectivo' });
    expect(legacyFields(v2({ origen: 'kash' }), CUENTAS)).toMatchObject({ method: 'transferencia' });
  });

  it('ingreso: el método según la cuenta de destino', () => {
    expect(legacyFields(v2({ tipo: 'ingreso', origen: null, destino: 'bi' }), CUENTAS)).toMatchObject({
      type: 'ingreso',
      method: 'debito',
    });
  });

  it('transferencias: retiro, depósito o transferencia como en v1', () => {
    expect(legacyFields(v2({ tipo: 'transferencia', origen: 'bi', destino: 'efectivo' }), CUENTAS).type).toBe('retiro');
    expect(legacyFields(v2({ tipo: 'transferencia', origen: 'efectivo', destino: 'bi' }), CUENTAS).type).toBe('deposito');
    expect(legacyFields(v2({ tipo: 'transferencia', origen: 'bi', destino: 'visa' }), CUENTAS)).toMatchObject({
      type: 'transferencia',
      method: 'debito',
    });
  });

  it('una cuenta desconocida da método "na" en lugar de romper', () => {
    expect(legacyFields(v2({ origen: 'borrada' }), CUENTAS).method).toBe('na');
  });
});

describe('de transacción guardada a movimiento v2', () => {
  it('ignora las transacciones de v1 y usa solo los campos v2 para el saldo', () => {
    const txns = [
      txn({ sk: 'a' }), // v1: no cuenta para el saldo nuevo
      txn({ sk: 'b', v2: v2({ origen: 'bi', montoCentavos: 10_000 }) }),
      txn({ sk: 'c', v2: v2({ tipo: 'transferencia', origen: 'bi', destino: 'visa', montoCentavos: 100_000 }) }),
    ];
    const movs = toMovimientos(txns);
    expect(movs).toHaveLength(2);
    const s = saldos(CUENTAS, movs);
    expect(s.get('bi')).toBe(390_000);
    expect(s.get('visa')).toBe(0);
  });
});

describe('visibilidad según el modelo activo', () => {
  it('v1 ve todo; v2 solo lo registrado con el modelo nuevo (los datos de prueba quedan fuera sin borrarse)', () => {
    const vieja = txn({});
    const nueva = txn({ v2: v2({}) });
    expect(isVisibleInModel(vieja, 'v1')).toBe(true);
    expect(isVisibleInModel(nueva, 'v1')).toBe(true);
    expect(isVisibleInModel(vieja, 'v2')).toBe(false);
    expect(isVisibleInModel(nueva, 'v2')).toBe(true);
  });
});
