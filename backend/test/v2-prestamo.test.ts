import { describe, expect, it } from 'vitest';
import { totales } from '../src/lib/v2/balance';
import { planCrearCuenta, planEditarCuenta, resumenCuenta } from '../src/lib/v2/config';
import type { ConfigSnapshot, CrearCuentaInput, EditarCuentaInput } from '../src/lib/v2/config';
import { calcularLibre, renderLibre } from '../src/lib/v2/libre';
import { esDeuda, esLiquida, validateConfig, validateMovimiento } from '../src/lib/v2/model';
import type { Cuenta, Movimiento } from '../src/lib/v2/model';
import { resolverCuenta } from '../src/lib/v2/resolver';
import type { SaldoV2 } from '../src/lib/v2/saldos';
import { renderSaldosV2, toLegacyBalances } from '../src/lib/v2/saldos';

const TODAY = '2026-11-24';

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
const saldo = (c: Cuenta, saldoCentavos = c.semillaCentavos): SaldoV2 => ({ cuenta: c, saldoCentavos, movimientos: 0 });

const BANCO = cuenta({ id: 'banco-a', nombre: 'Banco A', tipo: 'banco', entidadId: 'banco-x', semillaCentavos: 500_000 });
const TARJETA = cuenta({
  id: 'tc-x',
  nombre: 'TC X',
  tipo: 'credito',
  entidadId: 'banco-x',
  semillaCentavos: -200_000,
  credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'ninguno', diasAviso: [] },
});
const PRESTAMO = cuenta({
  id: 'prestamo-x',
  nombre: 'Préstamo X',
  tipo: 'prestamo',
  entidadId: 'banco-x',
  alias: ['el prestamo'],
  semillaCentavos: -10_000_000,
  prestamo: { cuotaCentavos: 300_000, diaPago: 5 },
});
const SNAP: ConfigSnapshot = {
  entidades: [{ id: 'banco-x', nombre: 'Banco X', alias: ['banco x'] }],
  cuentas: [BANCO, TARJETA, PRESTAMO],
};

describe('clasificación de cuentas', () => {
  it('un préstamo es deuda, nunca liquidez', () => {
    expect(esLiquida(PRESTAMO)).toBe(false);
    expect(esDeuda(PRESTAMO)).toBe(true);
    expect(esLiquida(BANCO)).toBe(true);
    expect(esDeuda(TARJETA)).toBe(true);
  });

  it('totales separan disponible, deuda de tarjetas y préstamos', () => {
    expect(totales(SNAP.cuentas.map((c) => saldo(c)))).toEqual({ disponible: 500_000, deuda: 200_000, prestamos: 10_000_000 });
  });

  it('un préstamo cerrado no suma', () => {
    expect(totales([saldo({ ...PRESTAMO, activa: false })]).prestamos).toBe(0);
  });
});

describe('/libre y /saldos con préstamo', () => {
  const input = {
    hoy: TODAY,
    saldos: SNAP.cuentas.map((c) => saldo(c)),
    tarjetas: [],
    proximos: [],
    recurrentes: [],
    gastoDiarioCentavos: 0,
  };

  it('el préstamo no infla el disponible', () => {
    const l = calcularLibre(input);
    expect(l.disponible).toBe(500_000);
    expect(l.deuda).toBe(200_000);
    expect(l.prestamos).toBe(10_000_000);
    expect(renderLibre(l, 0)).toContain('Préstamos: Q100,000.00');
  });

  it('/saldos muestra la deuda del préstamo y el neto la incluye', () => {
    const html = renderSaldosV2(input.saldos);
    expect(html).toContain('Préstamo X: debes <b>Q100,000.00</b> · cuota Q3,000.00 el 5');
    expect(html).toContain('Disponible: <b>Q5,000.00</b>');
    expect(html).toContain('Préstamos: <b>Q100,000.00</b>');
    expect(html).toContain('Neto: -Q97,000.00');
  });

  it('sin préstamos no aparece la línea', () => {
    expect(renderSaldosV2([saldo(BANCO)])).not.toContain('Préstamos');
  });

  it('los saldos legados marcan el préstamo', () => {
    const legacy = toLegacyBalances(input.saldos);
    expect(legacy.find((b) => b.id === ('prestamo-x' as never))?.prestamo).toBe(true);
    expect(legacy.find((b) => b.id === ('banco-a' as never))?.prestamo).toBeUndefined();
  });
});

describe('resolver', () => {
  it('nombrar el banco no ofrece su préstamo', () => {
    expect(resolverCuenta('pagué con débito banco x', SNAP)).toEqual({ tipo: 'cuenta', cuentaId: 'banco-a', fuente: 'alias' });
    const r = resolverCuenta('pagué con banco x', SNAP);
    expect(r.tipo === 'ambigua' && r.candidatas).toEqual(['banco-a', 'tc-x']);
  });

  it('el préstamo se encuentra por su alias', () => {
    expect(resolverCuenta('pagué la cuota de el prestamo', SNAP)).toEqual({ tipo: 'cuenta', cuentaId: 'prestamo-x', fuente: 'alias' });
  });
});

describe('validaciones', () => {
  const mov = (m: Partial<Movimiento>): Movimiento => ({
    fecha: TODAY,
    montoCentavos: 300_000,
    tipo: 'transferencia',
    origen: 'banco-a',
    destino: 'prestamo-x',
    categoria: 'deuda',
    descripcion: 'cuota',
    cuentaFuente: 'modelo',
    ...m,
  });

  it('la cuota es una transferencia válida al préstamo', () => {
    expect(validateMovimiento(mov({}), SNAP.cuentas)).toEqual({ errors: [], warnings: [] });
  });

  it('advierte un ingreso hacia el préstamo y un gasto desde él', () => {
    expect(validateMovimiento(mov({ tipo: 'ingreso', origen: null }), SNAP.cuentas).warnings).toHaveLength(1);
    expect(validateMovimiento(mov({ tipo: 'gasto', origen: 'prestamo-x', destino: null }), SNAP.cuentas).warnings).toHaveLength(1);
  });

  it('solo un préstamo lleva datos de préstamo', () => {
    const banco = { ...BANCO, prestamo: { cuotaCentavos: 1 } };
    expect(validateConfig([banco], SNAP.entidades).errors).toEqual(['Solo los préstamos tienen datos de préstamo ("banco-a").']);
  });
});

const crear = (over: Partial<CrearCuentaInput>): CrearCuentaInput => ({
  nombre: 'Préstamo Y',
  tipo: 'prestamo',
  entidad: 'Banco X',
  alias: [],
  terminaciones: [],
  saldoActual: 150_000,
  diaCorte: null,
  diaPago: 5,
  limite: null,
  tasaInteres: 18,
  periodoTasa: null,
  cuotaMensual: 4_500,
  plazoCuotas: 48,
  vence: '2030-11-05',
  ...over,
});

describe('crear préstamo', () => {
  it('guarda la deuda en negativo y sus datos (tasa anual por omisión)', () => {
    const r = planCrearCuenta(crear({}), SNAP, TODAY);
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value.cuenta.semillaCentavos).toBe(-15_000_000);
    expect(r.value.cuenta.prestamo).toEqual({
      cuotaCentavos: 450_000,
      diaPago: 5,
      plazoCuotas: 48,
      vence: '2030-11-05',
      interes: { tasaBps: 1800, periodo: 'anual' },
    });
    expect(r.value.cuenta.credito).toBeUndefined();
    expect(resumenCuenta(r.value.cuenta, SNAP.entidades)).toContain('Deuda: Q150,000.00');
  });

  it('rechaza corte o límite en un préstamo', () => {
    const r = planCrearCuenta(crear({ diaCorte: 20 }), SNAP, TODAY);
    expect(r.ok).toBe(false);
  });

  it('rechaza cuota en una cuenta de banco', () => {
    const r = planCrearCuenta(crear({ tipo: 'banco', diaPago: null, tasaInteres: null }), SNAP, TODAY);
    expect(r.ok === false && r.errors).toEqual(['Solo los préstamos tienen cuota, plazo y vencimiento.']);
  });
});

describe('convertir una cuenta de banco en préstamo', () => {
  const MAL = cuenta({ id: 'prestamo-z', nombre: 'Préstamo Z', tipo: 'banco', semillaCentavos: 12_000_000 });
  const snap: ConfigSnapshot = { entidades: SNAP.entidades, cuentas: [BANCO, MAL] };
  const editar = (over: Partial<EditarCuentaInput>): EditarCuentaInput => ({
    cuenta: 'prestamo-z',
    nuevoNombre: null,
    agregarAlias: [],
    quitarAlias: [],
    agregarTerminaciones: [],
    quitarTerminaciones: [],
    saldoActual: null,
    activa: null,
    nuevoTipo: 'prestamo',
    diaCorte: null,
    diaPago: null,
    limite: null,
    tasaInteres: null,
    periodoTasa: null,
    cuotaMensual: null,
    plazoCuotas: null,
    vence: null,
    ...over,
  });

  it('sin saldo nuevo, la deuda guardada en positivo pasa a negativo', () => {
    const r = planEditarCuenta(editar({}), snap, TODAY);
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value.despues.tipo).toBe('prestamo');
    expect(r.value.despues.semillaCentavos).toBe(-12_000_000);
    expect(r.value.despues.asOf).toBe(MAL.asOf);
  });

  it('con saldo y cuota nuevos los toma', () => {
    const r = planEditarCuenta(editar({ saldoActual: 119_000, cuotaMensual: 3_000, diaPago: 5 }), snap, TODAY);
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value.despues.semillaCentavos).toBe(-11_900_000);
    expect(r.value.despues.asOf).toBe(TODAY);
    expect(r.value.despues.prestamo).toEqual({ cuotaCentavos: 300_000, diaPago: 5 });
  });

  it('no convierte tarjetas', () => {
    const r = planEditarCuenta(editar({ cuenta: 'tc-x', nuevoTipo: 'prestamo' }), SNAP, TODAY);
    expect(r.ok).toBe(false);
  });

  it('volver de préstamo a banco quita sus datos y el signo', () => {
    const r = planEditarCuenta(editar({ cuenta: 'prestamo-x', nuevoTipo: 'banco' }), SNAP, TODAY);
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.value.despues.prestamo).toBeUndefined();
    expect(r.value.despues.semillaCentavos).toBe(10_000_000);
  });

  it('cuota en una cuenta que sigue siendo banco se rechaza', () => {
    const r = planEditarCuenta(editar({ cuenta: 'banco-a', nuevoTipo: null, cuotaMensual: 100 }), SNAP, TODAY);
    expect(r.ok).toBe(false);
  });
});
