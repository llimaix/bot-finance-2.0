import { describe, expect, it } from 'vitest';
import type { Transaction, TransactionV2 } from '../src/lib/types';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import type { Cuenta } from '../src/lib/v2/model';
import { computeSaldosV2, renderAffectedV2, renderSaldosV2, toLegacyBalances } from '../src/lib/v2/saldos';

const cuenta = (c: Partial<Cuenta> & Pick<Cuenta, 'id' | 'nombre' | 'tipo'>): Cuenta => ({
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...c,
});

const SNAP: ConfigSnapshot = {
  entidades: [],
  cuentas: [
    cuenta({ id: 'bi', nombre: 'BI Débito', tipo: 'banco', semillaCentavos: 500_000, terminaciones: ['2222'] }),
    cuenta({
      id: 'visa',
      nombre: 'Visa BAC',
      tipo: 'credito',
      semillaCentavos: -150_000,
      terminaciones: ['1111'],
      credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'siguiente_habil', diasAviso: [] },
    }),
    cuenta({ id: 'efectivo', nombre: 'Efectivo', tipo: 'efectivo', estimada: true }),
    cuenta({ id: 'vieja', nombre: 'Cuenta vieja', tipo: 'banco', activa: false }),
  ],
};

const txn = (sk: string, v2?: Partial<TransactionV2>): Transaction => ({
  sk,
  date: '2026-11-22',
  shortId: 1,
  amount: 0,
  type: 'gasto',
  category: 'comida',
  method: 'debito',
  description: '',
  rawMessage: '',
  createdAt: '',
  ...(v2 ? { v2: { montoCentavos: 0, tipo: 'gasto', origen: null, destino: null, cuentaFuente: 'alias', ...v2 } } : {}),
});

const TXNS = [
  txn('v1-de-prueba'), // sin v2: no cuenta
  txn('compra', { montoCentavos: 30_000, origen: 'visa' }),
  txn('pago', { tipo: 'transferencia', montoCentavos: 100_000, origen: 'bi', destino: 'visa' }),
];

describe('saldos v2', () => {
  const saldos = computeSaldosV2(SNAP, TXNS);
  const de = (id: string) => saldos.find((s) => s.cuenta.id === id)!;

  it('partida doble sobre los movimientos con v2, ignorando los de v1', () => {
    expect(de('bi')).toMatchObject({ saldoCentavos: 400_000, movimientos: 1 });
    expect(de('visa')).toMatchObject({ saldoCentavos: -80_000, movimientos: 2 });
    expect(de('efectivo')).toMatchObject({ saldoCentavos: 0, movimientos: 0 });
  });

  it('/saldo: deuda, disponible y uso del límite en tarjetas; totales sin cuentas cerradas', () => {
    const html = renderSaldosV2(saldos);
    expect(html).toContain('Visa BAC ••1111: debes <b>Q800.00</b> · disponible Q9,200.00 (8% del límite)');
    expect(html).toContain('BI Débito ••2222: <b>Q4,000.00</b>');
    expect(html).toContain('Efectivo: <b>Q0.00</b> <i>(sin saldo inicial)</i>');
    expect(html).toContain('Disponible: <b>Q4,000.00</b>');
    expect(html).toContain('Deuda de tarjetas: <b>Q800.00</b>');
    expect(html).toContain('Neto: Q3,200.00');
    expect(html).not.toContain('Cuenta vieja');
  });

  it('sin cuentas configuradas explica cómo agregarlas', () => {
    expect(renderSaldosV2([])).toContain('Aún no hay cuentas');
  });

  it('después de registrar, solo las cuentas tocadas', () => {
    const lineas = renderAffectedV2([TXNS[1]!], saldos);
    expect(lineas).toHaveLength(1);
    expect(lineas[0]).toContain('Visa BAC');
  });

  it('forma v1 para el código existente: quetzales, deuda en negativo y sin cuentas cerradas', () => {
    const legacy = toLegacyBalances(saldos);
    expect(legacy.map((b) => [b.id, b.balance])).toEqual([
      ['bi', 4000],
      ['visa', -800],
      ['efectivo', 0],
    ]);
  });
});
