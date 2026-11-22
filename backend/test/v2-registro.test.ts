import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import type { Cuenta } from '../src/lib/v2/model';
import { planRegistroV2 } from '../src/lib/v2/registro';
import type { PropuestaV2 } from '../src/lib/v2/registro';

const credito = { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'siguiente_habil' as const, diasAviso: [] };
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

const SNAP: ConfigSnapshot = {
  entidades: [{ id: 'bi', nombre: 'Banco Industrial', alias: ['bi'] }],
  cuentas: [
    cuenta({ id: 'bi-debito', nombre: 'BI Débito', tipo: 'banco', entidadId: 'bi', terminaciones: ['2222'] }),
    cuenta({ id: 'bi-mc', nombre: 'Mastercard BI', tipo: 'credito', entidadId: 'bi', terminaciones: ['3333'], credito }),
    cuenta({ id: 'visa', nombre: 'Visa BAC', tipo: 'credito', terminaciones: ['1111'], alias: ['la visa'], credito }),
    cuenta({ id: 'efectivo', nombre: 'Efectivo', tipo: 'efectivo' }),
  ],
};

const p = (over: Partial<PropuestaV2>): PropuestaV2 => ({
  amount: 45,
  type: 'gasto',
  category: 'comida',
  description: 'almuerzo',
  date: '2026-11-22',
  origen: null,
  destino: null,
  ...over,
});

describe('registro v2', () => {
  it('gasto con la cuenta que propone el modelo: centavos, campos v1 derivados y sin origen/destino sueltos', () => {
    const r = planRegistroV2([p({ origen: 'efectivo' })], 'almuerzo Q45', SNAP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.txns[0]!;
    expect(t.v2).toEqual({ montoCentavos: 4_500, tipo: 'gasto', origen: 'efectivo', destino: null, cuentaFuente: 'modelo' });
    expect(t).toMatchObject({ amount: 45, type: 'gasto', method: 'efectivo' });
    expect('origen' in t).toBe(false);
  });

  it('la terminación del texto manda sobre la propuesta del modelo', () => {
    const r = planRegistroV2([p({ origen: 'efectivo' })], 'Q200 súper, la que termina en 1111', SNAP);
    expect(r.ok && r.txns[0]!.v2).toMatchObject({ origen: 'visa', cuentaFuente: 'terminacion' });
  });

  it('la terminación de una imagen manda aunque no haya texto', () => {
    const r = planRegistroV2([p({ origen: null })], '', SNAP, '3333');
    expect(r.ok && r.txns[0]!.v2).toMatchObject({ origen: 'bi-mc', cuentaFuente: 'terminacion' });
  });

  it('el alias de la cuenta resuelve aunque el modelo no proponga nada', () => {
    const r = planRegistroV2([p({})], 'gasolina Q200 con la visa', SNAP);
    expect(r.ok && r.txns[0]!.v2).toMatchObject({ origen: 'visa', cuentaFuente: 'alias' });
  });

  it('ingreso: la cuenta resuelta va al destino', () => {
    const r = planRegistroV2([p({ type: 'ingreso', amount: 8000, category: 'salario' })], 'me cayó el salario en la que termina en 2222', SNAP);
    expect(r.ok && r.txns[0]!).toMatchObject({ type: 'ingreso', v2: { origen: null, destino: 'bi-debito' } });
  });

  it('pago de tarjeta y retiro: transferencias con origen y destino', () => {
    const r = planRegistroV2(
      [p({ type: 'transferencia', amount: 1000, origen: 'bi-debito', destino: 'visa' }), p({ type: 'retiro', amount: 500, origen: 'bi-debito', destino: 'efectivo' })],
      'pagué la visa y saqué del cajero',
      SNAP,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.txns.map((t) => [t.v2.tipo, t.type])).toEqual([
      ['transferencia', 'transferencia'],
      ['transferencia', 'retiro'],
    ]);
  });

  it('con varios movimientos no impone la pista del texto a todos', () => {
    const r = planRegistroV2(
      [p({ origen: 'efectivo' }), p({ amount: 200, category: 'gasolina', origen: 'visa' })],
      'almuerzo Q45 en efectivo y Q200 de gasolina con la visa',
      SNAP,
    );
    expect(r.ok && r.txns.map((t) => t.v2.origen)).toEqual(['efectivo', 'visa']);
  });

  it('sin cuenta: no guarda nada y pide preguntar, con las candidatas si es ambiguo', () => {
    const r = planRegistroV2([p({})], 'Q100 con BI', SNAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores[0]).toContain('BI Débito o Mastercard BI');
  });

  it('terminación desconocida: no guarda y pide agregarla', () => {
    const r = planRegistroV2([p({ origen: 'efectivo' })], 'termina en 4444', SNAP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores[0]).toContain('••4444');
  });

  it('si un movimiento falla, no se guarda ninguno del mensaje', () => {
    const r = planRegistroV2([p({ origen: 'efectivo' }), p({ type: 'transferencia', origen: 'bi-debito', destino: null })], 'x', SNAP);
    expect(r.ok).toBe(false);
  });

  it('sin cuentas configuradas, pide crearlas primero', () => {
    const r = planRegistroV2([p({ origen: 'x' })], 'almuerzo', { cuentas: [], entidades: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores[0]).toContain('crear_cuenta');
  });
});
