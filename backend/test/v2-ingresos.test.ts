import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import { conciliado, fechasDelMes, planIngreso, proximosIngresos, resumenIngreso } from '../src/lib/v2/ingresos';
import type { IngresoEsperado, IngresoInput } from '../src/lib/v2/ingresos';
import type { Cuenta, Movimiento } from '../src/lib/v2/model';

const cuenta = (id: string, tipo: Cuenta['tipo']): Cuenta => ({
  id,
  nombre: id === 'bi' ? 'BI Débito' : id,
  tipo,
  entidadId: null,
  terminaciones: id === 'bi' ? ['2222'] : [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...(tipo === 'credito'
    ? { credito: { limiteCentavos: 1, diaCorte: 1, diaPago: 2, ajustePago: 'ninguno' as const, diasAviso: [] } }
    : {}),
});
const SNAP: ConfigSnapshot = { entidades: [], cuentas: [cuenta('bi', 'banco'), cuenta('visa', 'credito')] };

const salario: IngresoEsperado = {
  slug: 'salario',
  descripcion: 'Salario',
  montoCentavos: 800_000,
  cuentaDestino: 'bi',
  dias: [15, 31],
  ajuste: 'anterior_habil',
  activo: true,
};

const ingreso = (fecha: string, montoCentavos: number, destino = 'bi'): Movimiento => ({
  fecha,
  montoCentavos,
  tipo: 'ingreso',
  origen: null,
  destino,
  categoria: 'salario',
  descripcion: '',
  cuentaFuente: 'usuario',
});

describe('fechas esperadas', () => {
  it('15 y último día, ajustados al hábil anterior (15-nov-2026 es domingo)', () => {
    expect(fechasDelMes(salario, '2026-11')).toEqual(['2026-11-13', '2026-11-30']);
    expect(fechasDelMes(salario, '2026-12')).toEqual(['2026-12-15', '2026-12-31']);
  });

  it('próximos ingresos en orden, cruzando de mes', () => {
    expect(proximosIngresos([salario], '2026-11-14').map((x) => x.fecha)).toEqual(['2026-11-30', '2026-12-15']);
    expect(proximosIngresos([{ ...salario, activo: false }], '2026-11-14')).toEqual([]);
  });
});

describe('conciliación (±3 días, ±10 %)', () => {
  it('en el límite de días y de monto concilia', () => {
    expect(conciliado(salario, '2026-11-13', [ingreso('2026-11-16', 720_000)])).toBe(true);
  });

  it('fuera de margen, en otra cuenta o sin ingreso no concilia', () => {
    expect(conciliado(salario, '2026-11-13', [ingreso('2026-11-17', 800_000)])).toBe(false);
    expect(conciliado(salario, '2026-11-13', [ingreso('2026-11-13', 700_000)])).toBe(false);
    expect(conciliado(salario, '2026-11-13', [ingreso('2026-11-13', 800_000, 'efectivo')])).toBe(false);
    expect(conciliado(salario, '2026-11-13', [])).toBe(false);
  });
});

describe('configuración por el agente', () => {
  const input = (over: Partial<IngresoInput> = {}): IngresoInput => ({
    descripcion: 'Salario',
    monto: 8000,
    cuenta: '••2222',
    dias: [31, 15, 15],
    ajuste: null,
    activo: null,
    ...over,
  });

  it('crea el ingreso con la cuenta resuelta, días ordenados y ajuste por defecto', () => {
    const r = planIngreso(input(), SNAP, []);
    expect(r.ok && r.despues).toEqual(salario);
    expect(r.ok && r.antes).toBeNull();
  });

  it('con el mismo nombre actualiza el existente', () => {
    const r = planIngreso(input({ monto: 8500 }), SNAP, [salario]);
    expect(r.ok && r).toMatchObject({ antes: salario, despues: { montoCentavos: 850_000 } });
  });

  it('rechaza una cuenta inexistente o una tarjeta de crédito', () => {
    expect(planIngreso(input({ cuenta: 'nada' }), SNAP, []).ok).toBe(false);
    expect(planIngreso(input({ cuenta: 'visa' }), SNAP, []).ok).toBe(false);
  });

  it('el resumen describe el último día y el ajuste', () => {
    expect(resumenIngreso(salario, SNAP)).toBe(
      '💰 <b>Salario</b>: Q8,000.00 el 15 y último día (si cae en fin de semana, el hábil anterior) → BI Débito',
    );
  });
});
