import { describe, expect, it } from 'vitest';
import { normalizeAlias } from '../src/lib/v2/aliases';
import { saldoCentavos, saldos } from '../src/lib/v2/balance';
import { cuentaSchema, validateConfig, validateMovimiento } from '../src/lib/v2/model';
import type { Cuenta, EntidadBancaria, Movimiento } from '../src/lib/v2/model';
import { formatCents, isValidAmountCents, toCents } from '../src/lib/v2/money';

const cuenta = (over: Partial<Cuenta> & Pick<Cuenta, 'id' | 'tipo'>): Cuenta => ({
  nombre: over.id,
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-11-01',
  estimada: false,
  activa: true,
  ...over,
});

const credito: NonNullable<Cuenta['credito']> = {
  limiteCentavos: 1_000_000,
  diaCorte: 15,
  diaPago: 5,
  ajustePago: 'siguiente_habil',
  diasAviso: [5, 2, 0],
};

const BI = cuenta({ id: 'bi-debito', tipo: 'banco', entidadId: 'bi', semillaCentavos: 500_000 });
const VISA = cuenta({ id: 'bac-visa', tipo: 'credito', entidadId: 'bac', credito: { ...credito }, semillaCentavos: -100_000 });
const EFECTIVO = cuenta({ id: 'efectivo', tipo: 'efectivo', semillaCentavos: 20_000 });
const CUENTAS = [BI, VISA, EFECTIVO];

const mov = (over: Partial<Movimiento>): Movimiento => ({
  fecha: '2026-11-10',
  montoCentavos: 10_000,
  tipo: 'gasto',
  origen: null,
  destino: null,
  categoria: 'comida',
  descripcion: '',
  cuentaFuente: 'usuario',
  ...over,
});

describe('dinero en centavos', () => {
  it('0,10 + 0,20 da exactamente 30 centavos', () => {
    expect(toCents(0.1) + toCents(0.2)).toBe(30);
  });

  it('redondea bien representaciones binarias como 1,005', () => {
    expect(toCents(1.005)).toBe(101);
    expect(toCents(-1.005)).toBe(-101);
  });

  it('formatea en quetzales', () => {
    expect(formatCents(123_456)).toBe('Q1,234.56');
    expect(formatCents(-5_000)).toBe('-Q50.00');
    expect(formatCents(5)).toBe('Q0.05');
  });

  it('un monto válido es un entero mayor que 0', () => {
    expect(isValidAmountCents(1)).toBe(true);
    expect(isValidAmountCents(0)).toBe(false);
    expect(isValidAmountCents(-1)).toBe(false);
    expect(isValidAmountCents(1.5)).toBe(false);
  });

  it('rechaza montos no finitos', () => {
    expect(() => toCents(Number.NaN)).toThrow();
  });
});

describe('saldo por partida doble', () => {
  it('almuerzo con débito: baja el banco', () => {
    expect(saldoCentavos(BI, [mov({ origen: 'bi-debito', montoCentavos: 4_500 })])).toBe(495_500);
  });

  it('compra con crédito: la deuda crece (más negativa)', () => {
    expect(saldoCentavos(VISA, [mov({ origen: 'bac-visa', montoCentavos: 30_000 })])).toBe(-130_000);
  });

  it('pago de tarjeta desde el banco: baja el banco Y baja la deuda (incidentes 3-sep y 1-oct)', () => {
    const pago = mov({ tipo: 'transferencia', origen: 'bi-debito', destino: 'bac-visa', montoCentavos: 100_000 });
    const s = saldos(CUENTAS, [pago]);
    expect(s.get('bi-debito')).toBe(400_000);
    expect(s.get('bac-visa')).toBe(0);
  });

  it('retiro en cajero: baja el banco y sube el efectivo', () => {
    const retiro = mov({ tipo: 'transferencia', origen: 'bi-debito', destino: 'efectivo', montoCentavos: 50_000 });
    const s = saldos(CUENTAS, [retiro]);
    expect(s.get('bi-debito')).toBe(450_000);
    expect(s.get('efectivo')).toBe(70_000);
  });

  it('ignora los movimientos anteriores o iguales a asOf (ya están en la semilla)', () => {
    expect(saldoCentavos(BI, [mov({ origen: 'bi-debito', fecha: '2026-11-01' })])).toBe(500_000);
  });
});

describe('invariantes de un movimiento', () => {
  const errores = (m: Movimiento) => validateMovimiento(m, CUENTAS).errors;

  it('un gasto válido no tiene errores', () => {
    expect(errores(mov({ origen: 'bi-debito' }))).toEqual([]);
  });

  it('origen y destino iguales, o ambos nulos, son inválidos', () => {
    expect(errores(mov({ tipo: 'transferencia', origen: 'bi-debito', destino: 'bi-debito' }))).not.toEqual([]);
    expect(errores(mov({ origen: null, destino: null }))).not.toEqual([]);
  });

  it('gasto sin origen, ingreso sin destino y transferencia incompleta son inválidos', () => {
    expect(errores(mov({ tipo: 'gasto', origen: null, destino: 'efectivo' }))).toContain('Un gasto necesita la cuenta de origen.');
    expect(errores(mov({ tipo: 'ingreso', origen: 'bi-debito', destino: null }))).toContain('Un ingreso necesita la cuenta de destino.');
    expect(errores(mov({ tipo: 'transferencia', origen: 'bi-debito', destino: null }))).toContain(
      'Una transferencia necesita origen y destino.',
    );
  });

  it('una cuenta inexistente o cerrada es inválida', () => {
    expect(errores(mov({ origen: 'no-existe' })).join()).toContain('no existe');
    const cerrada = cuenta({ id: 'vieja', tipo: 'banco', activa: false });
    expect(validateMovimiento(mov({ origen: 'vieja' }), [cerrada]).errors.join()).toContain('cerrada');
  });

  it('montos de cero o con fracción de centavo son inválidos', () => {
    expect(errores(mov({ origen: 'bi-debito', montoCentavos: 0 }))).not.toEqual([]);
    expect(errores(mov({ origen: 'bi-debito', montoCentavos: 10.5 }))).not.toEqual([]);
  });

  it('un ingreso hacia una tarjeta de crédito se avisa, sin bloquear', () => {
    const v = validateMovimiento(mov({ tipo: 'ingreso', destino: 'bac-visa' }), CUENTAS);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toHaveLength(1);
  });
});

describe('invariantes de la configuración', () => {
  const entidades: EntidadBancaria[] = [
    { id: 'bi', nombre: 'Banco Industrial', alias: ['bi', 'Banco Industrial'] },
    { id: 'bac', nombre: 'BAC', alias: ['bac'] },
  ];

  it('una configuración correcta no tiene errores', () => {
    expect(validateConfig(CUENTAS, entidades).errors).toEqual([]);
  });

  it('cada terminación pertenece a una sola cuenta', () => {
    const a = { ...BI, terminaciones: ['1111'] };
    const b = { ...VISA, terminaciones: ['1111'] };
    expect(validateConfig([a, b], entidades).errors.join()).toContain('1111');
  });

  it('un alias normalizado no puede estar en dos sitios ("banco industrial" = "Banco Industrial")', () => {
    const conAlias = { ...BI, alias: ['banco  industrial'] };
    expect(validateConfig([conAlias], entidades).errors.join()).toContain('banco  industrial');
  });

  it('crédito sin datos de crédito, o datos de crédito en débito, son inválidos', () => {
    expect(validateConfig([{ ...VISA, credito: undefined }], entidades).errors).not.toEqual([]);
    expect(validateConfig([{ ...BI, credito: { ...credito } }], entidades).errors).not.toEqual([]);
  });

  it('una cuenta no puede apuntar a una entidad inexistente', () => {
    expect(validateConfig([{ ...BI, entidadId: 'otro' }], entidades).errors.join()).toContain('otro');
  });
});

describe('esquemas', () => {
  it('la terminación debe tener exactamente 4 dígitos', () => {
    expect(cuentaSchema.safeParse({ ...BI, terminaciones: ['111'] }).success).toBe(false);
    expect(cuentaSchema.safeParse({ ...BI, terminaciones: ['1111'] }).success).toBe(true);
  });

  it('la tasa de interés es un entero positivo de puntos básicos y es opcional', () => {
    const conTasa = { ...VISA, credito: { ...credito, interes: { tasaBps: 350, periodo: 'mensual' } } };
    const tasaDecimal = { ...VISA, credito: { ...credito, interes: { tasaBps: 3.5, periodo: 'mensual' } } };
    expect(cuentaSchema.safeParse(conTasa).success).toBe(true);
    expect(cuentaSchema.safeParse(tasaDecimal).success).toBe(false);
    expect(cuentaSchema.safeParse(VISA).success).toBe(true);
  });
});

describe('normalizeAlias', () => {
  it('ignora mayúsculas, tildes y espacios repetidos', () => {
    expect(normalizeAlias('  BANCO   Industrial ')).toBe('banco industrial');
    expect(normalizeAlias('Crédito')).toBe('credito');
  });
});
