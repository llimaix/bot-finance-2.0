import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import type { Cuenta } from '../src/lib/v2/model';
import { partirPago, tasaMensual } from '../src/lib/v2/prestamos';
import { planRegistroV2 } from '../src/lib/v2/registro';
import type { PropuestaV2 } from '../src/lib/v2/registro';

const cuenta = (c: Partial<Cuenta> & Pick<Cuenta, 'id' | 'tipo'>): Cuenta => ({
  nombre: c.id,
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...c,
});

// Préstamo ficticio de cuota fija: Q10,000 a 12 meses al 24 % anual (2 % mensual).
// Tabla esperada (sistema francés): cuota Q945.60; 1.ª cuota Q200.00 de interés
// y Q745.60 a capital; 2.ª cuota Q185.09 de interés y Q760.51 a capital.
const SNAP: ConfigSnapshot = {
  entidades: [],
  cuentas: [
    cuenta({ id: 'debito', nombre: 'Débito', tipo: 'banco' }),
    cuenta({
      id: 'prestamo',
      nombre: 'Préstamo',
      tipo: 'prestamo',
      prestamo: { cuotaCentavos: 94_560, diaPago: 5, interes: { tasaBps: 2_400, periodo: 'anual' } },
    }),
    cuenta({ id: 'sin-tasa', nombre: 'Préstamo sin tasa', tipo: 'prestamo', prestamo: { cuotaCentavos: 50_000 } }),
  ],
};
const DEUDAS = new Map([
  ['prestamo', 1_000_000],
  ['sin-tasa', 500_000],
]);

const pago = (over: Partial<PropuestaV2>): PropuestaV2 => ({
  amount: 945.6,
  type: 'transferencia',
  category: 'deuda',
  description: 'cuota',
  date: '2026-12-05',
  origen: 'debito',
  destino: 'prestamo',
  ...over,
});

describe('tasa mensual del préstamo', () => {
  it('convierte la tasa anual a mensual y respeta la mensual', () => {
    expect(tasaMensual(SNAP.cuentas[1]!)).toBeCloseTo(0.02, 10);
    expect(
      tasaMensual(cuenta({ id: 'x', tipo: 'prestamo', prestamo: { interes: { tasaBps: 300, periodo: 'mensual' } } })),
    ).toBeCloseTo(0.03, 10);
  });

  it('null si no hay tasa o la cuenta no es préstamo', () => {
    expect(tasaMensual(SNAP.cuentas[2]!)).toBeNull();
    expect(tasaMensual(SNAP.cuentas[0]!)).toBeNull();
  });
});

describe('partir un pago entre interés y capital', () => {
  it('reproduce la tabla de amortización', () => {
    expect(partirPago(94_560, 1_000_000, 0.02, null)).toEqual({ interesCentavos: 20_000, capitalCentavos: 74_560 });
    expect(partirPago(94_560, 925_440, 0.02, null)).toEqual({ interesCentavos: 18_509, capitalCentavos: 76_051 });
  });

  it('el interés del estado de cuenta prevalece sobre el calculado', () => {
    expect(partirPago(94_560, 1_000_000, 0.02, 21_000)).toEqual({ interesCentavos: 21_000, capitalCentavos: 73_560 });
  });

  it('si el pago no cubre el interés, todo es interés', () => {
    expect(partirPago(15_000, 1_000_000, 0.02, null)).toEqual({ interesCentavos: 15_000, capitalCentavos: 0 });
  });

  it('el excedente sobre la cuota va a capital', () => {
    expect(partirPago(200_000, 1_000_000, 0.02, null)).toEqual({ interesCentavos: 20_000, capitalCentavos: 180_000 });
  });
});

describe('registro del pago de un préstamo', () => {
  it('parte la cuota en un gasto de intereses y una transferencia de capital que suman el pago', () => {
    const r = planRegistroV2([pago({})], 'pagué la cuota del préstamo', SNAP, null, DEUDAS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.avisos).toEqual([]);
    expect(r.txns.map((t) => t.v2)).toEqual([
      { montoCentavos: 20_000, tipo: 'gasto', origen: 'debito', destino: null, cuentaFuente: 'modelo' },
      { montoCentavos: 74_560, tipo: 'transferencia', origen: 'debito', destino: 'prestamo', cuentaFuente: 'modelo' },
    ]);
    expect(r.txns[0]).toMatchObject({ amount: 200, type: 'gasto', category: 'deuda', description: 'Intereses Préstamo' });
    expect(r.txns[1]).toMatchObject({ amount: 745.6, type: 'transferencia', description: 'Capital Préstamo' });
    expect('interes' in r.txns[0]!).toBe(false);
  });

  it('dos cuotas en el mismo mensaje: la segunda se calcula sobre la deuda que dejó la primera', () => {
    const r = planRegistroV2([pago({}), pago({ date: '2027-01-05' })], 'pagué dos cuotas', SNAP, null, DEUDAS);
    expect(r.ok && r.txns.map((t) => t.v2.montoCentavos)).toEqual([20_000, 74_560, 18_509, 76_051]);
  });

  it('usa el interés del estado de cuenta si el usuario lo dio', () => {
    const r = planRegistroV2([pago({ interes: 210 })], 'cuota, intereses Q210', SNAP, null, DEUDAS);
    expect(r.ok && r.txns.map((t) => t.v2.montoCentavos)).toEqual([21_000, 73_560]);
  });

  it('si el pago no cubre el interés: solo el gasto de intereses y un aviso', () => {
    const r = planRegistroV2([pago({ amount: 150 })], 'abono al préstamo', SNAP, null, DEUDAS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.txns.map((t) => t.v2)).toEqual([
      { montoCentavos: 15_000, tipo: 'gasto', origen: 'debito', destino: null, cuentaFuente: 'modelo' },
    ]);
    expect(r.avisos).toHaveLength(1);
    expect(r.avisos[0]).toContain('no cubre los intereses');
  });

  it('préstamo sin tasa: una sola transferencia por el pago completo, como antes', () => {
    const r = planRegistroV2([pago({ amount: 500, destino: 'sin-tasa' })], 'cuota', SNAP, null, DEUDAS);
    expect(r.ok && r.txns.map((t) => t.v2)).toEqual([
      { montoCentavos: 50_000, tipo: 'transferencia', origen: 'debito', destino: 'sin-tasa', cuentaFuente: 'modelo' },
    ]);
  });

  it('sin deudas conocidas no inventa intereses', () => {
    const r = planRegistroV2([pago({})], 'cuota', SNAP);
    expect(r.ok && r.txns.map((t) => t.v2.montoCentavos)).toEqual([94_560]);
  });
});
