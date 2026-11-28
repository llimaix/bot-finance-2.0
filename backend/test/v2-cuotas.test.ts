import { describe, expect, it } from 'vitest';
import type { CicloTarjeta } from '../src/lib/v2/ciclos';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import {
  calendarioCuotas,
  cuotaSk,
  cuotasVencidas,
  findPlan,
  lineasPlanes,
  montoCuota,
  movimientoCuota,
  planCompraCuotas,
  porFacturarPlan,
  porFacturarTarjeta,
} from '../src/lib/v2/cuotas';
import type { CompraCuotasInput, PlanCuotas } from '../src/lib/v2/cuotas';
import type { Cuenta } from '../src/lib/v2/model';
import { alertasTarjetas, renderTarjetas } from '../src/lib/v2/tarjetas';

const cuenta = (c: Partial<Cuenta> & Pick<Cuenta, 'id' | 'tipo'>): Cuenta => ({
  nombre: c.id,
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2027-01-01',
  estimada: false,
  activa: true,
  ...c,
});

const TARJETA = cuenta({
  id: 'visa',
  nombre: 'Visa',
  tipo: 'credito',
  terminaciones: ['1111'],
  credito: { limiteCentavos: 2_000_000, diaCorte: 21, diaPago: 14, ajustePago: 'ninguno', diasAviso: [] },
});
const SNAP: ConfigSnapshot = {
  entidades: [],
  cuentas: [TARJETA, cuenta({ id: 'debito', nombre: 'Débito', tipo: 'banco' })],
};

// Datos ficticios: Q10,000 en 10 cuotas sin intereses.
const PLAN: PlanCuotas = {
  id: 'refrigeradora',
  tarjetaId: 'visa',
  descripcion: 'Refrigeradora',
  categoria: 'hogar',
  montoCentavos: 1_000_000,
  cuotas: 10,
  fechaCompra: '2027-02-10',
  activo: true,
};

describe('monto de cada cuota', () => {
  it('partes iguales y la última se queda con los centavos que sobran', () => {
    const plan = { montoCentavos: 1_000_000, cuotas: 3 };
    expect([1, 2, 3].map((n) => montoCuota(plan, n))).toEqual([333_333, 333_333, 333_334]);
    expect([1, 2, 3].reduce((a, n) => a + montoCuota(plan, n), 0)).toBe(1_000_000);
  });
});

describe('calendario de cuotas', () => {
  it('la primera cuota cae en el primer corte desde la compra, una por mes', () => {
    const fechas = calendarioCuotas(PLAN, 21).map((c) => c.fecha);
    expect(fechas.slice(0, 3)).toEqual(['2027-02-21', '2027-03-21', '2027-04-21']);
    expect(fechas).toHaveLength(10);
    expect(fechas[9]).toBe('2027-11-21');
  });

  it('una compra el mismo día del corte entra en ese corte; un día después, en el siguiente', () => {
    expect(calendarioCuotas({ ...PLAN, fechaCompra: '2027-02-21' }, 21)[0]!.fecha).toBe('2027-02-21');
    expect(calendarioCuotas({ ...PLAN, fechaCompra: '2027-02-22' }, 21)[0]!.fecha).toBe('2027-03-21');
  });

  it('corte 31 en un mes corto: el último día del mes', () => {
    expect(calendarioCuotas({ ...PLAN, fechaCompra: '2027-01-31' }, 31).map((c) => c.fecha).slice(0, 2)).toEqual([
      '2027-01-31',
      '2027-02-28',
    ]);
  });

  it('cruza el fin de año', () => {
    const fechas = calendarioCuotas({ ...PLAN, fechaCompra: '2027-11-25' }, 21).map((c) => c.fecha);
    expect(fechas.slice(0, 2)).toEqual(['2027-12-21', '2028-01-21']);
  });
});

describe('cuotas vencidas y por facturar', () => {
  it('a mitad del plan', () => {
    expect(cuotasVencidas(PLAN, 21, '2027-03-25').map((c) => c.numero)).toEqual([1, 2]);
    expect(porFacturarPlan(PLAN, 21, '2027-03-25')).toBe(800_000);
  });

  it('antes del primer corte todo está por facturar; al terminar, nada', () => {
    expect(porFacturarPlan(PLAN, 21, '2027-02-15')).toBe(1_000_000);
    expect(porFacturarPlan(PLAN, 21, '2027-11-21')).toBe(0);
  });

  it('un plan cerrado no deja nada por facturar', () => {
    expect(porFacturarPlan({ ...PLAN, activo: false }, 21, '2027-03-25')).toBe(0);
  });

  it('por tarjeta suma solo sus planes', () => {
    const otro = { ...PLAN, id: 'tv', tarjetaId: 'otra' };
    expect(porFacturarTarjeta([PLAN, otro], TARJETA, '2027-03-25')).toBe(800_000);
  });
});

describe('movimiento de cada cuota', () => {
  it('SK determinista por plan y número de cuota', () => {
    expect(cuotaSk('refrigeradora', { numero: 1, fecha: '2027-02-21' })).toBe('TXN#2027-02-21#CUO-refrigeradora-01');
  });

  it('es un gasto en la tarjeta con la categoría de la compra', () => {
    const cuota = calendarioCuotas(PLAN, 21)[1]!;
    expect(movimientoCuota(PLAN, cuota)).toEqual({
      date: '2027-03-21',
      category: 'hogar',
      description: 'Refrigeradora (cuota 2/10)',
      v2: { montoCentavos: 100_000, tipo: 'gasto', origen: 'visa', destino: null, cuentaFuente: 'usuario' },
    });
  });
});

describe('registrar una compra a cuotas', () => {
  const input = (over: Partial<CompraCuotasInput>): CompraCuotasInput => ({
    tarjeta: '1111',
    descripcion: 'Refrigeradora',
    categoria: 'hogar',
    montoTotal: 10_000,
    cuotas: 10,
    fechaCompra: null,
    ...over,
  });

  it('arma el plan con la tarjeta, el total en centavos y la fecha de hoy', () => {
    const r = planCompraCuotas(input({}), SNAP, [], ['hogar'], '2027-02-10');
    expect(r).toEqual({ ok: true, value: PLAN });
  });

  it('no repite el id de un plan existente', () => {
    const r = planCompraCuotas(input({}), SNAP, [PLAN], ['hogar'], '2027-02-10');
    expect(r.ok && r.value.id).toBe('refrigeradora-2');
  });

  it('rechaza lo que no cuadra: cuenta que no es tarjeta, categoría inexistente, 1 cuota y fecha futura', () => {
    expect(planCompraCuotas(input({ tarjeta: 'debito' }), SNAP, [], ['hogar'], '2027-02-10').ok).toBe(false);
    const r = planCompraCuotas(input({ categoria: 'nada', cuotas: 1, fechaCompra: '2027-03-01' }), SNAP, [], ['hogar'], '2027-02-10');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(3);
  });
});

describe('buscar un plan', () => {
  it('por descripción sin importar acentos ni mayúsculas, o por id; solo activos', () => {
    const plan = { ...PLAN, descripcion: 'Televisión' };
    expect(findPlan('television', [plan])?.id).toBe('refrigeradora');
    expect(findPlan('refrigeradora', [plan])?.id).toBe('refrigeradora');
    expect(findPlan('television', [{ ...plan, activo: false }])).toBeUndefined();
  });
});

describe('/tarjetas y avisos con cuotas por facturar', () => {
  const ciclo: CicloTarjeta = {
    cuentaId: 'visa',
    ultimoCorte: '2027-03-21',
    proximoCorte: '2027-04-21',
    fechaPago: '2027-04-14',
    deudaAlCorte: 100_000,
    pagado: 0,
    pendiente: 100_000,
    consumoPeriodo: 0,
    deudaActual: 900_000,
    interesEstimado: null,
    aproximado: false,
  };
  const hoy = '2027-03-25';

  it('el disponible descuenta lo que falta facturar y se lista cada compra', () => {
    const texto = renderTarjetas(
      [{ cuenta: TARJETA, ciclo, porFacturar: 800_000, cuotas: lineasPlanes([PLAN], TARJETA, hoy) }],
      hoy,
    );
    expect(texto).toContain('cuotas por facturar Q8,000.00 · disponible Q3,000.00 de Q20,000.00 (85%)');
    expect(texto).toContain('Refrigeradora: cuota 2/10 de Q1,000.00 · por facturar Q8,000.00');
  });

  it('el aviso de uso del límite cuenta las cuotas por facturar', () => {
    expect(alertasTarjetas([{ cuenta: TARJETA, ciclo, porFacturar: 800_000 }], hoy).some((a) => a.includes('85% de su límite'))).toBe(true);
    expect(alertasTarjetas([{ cuenta: TARJETA, ciclo }], hoy).some((a) => a.includes('de su límite'))).toBe(false);
  });
});
