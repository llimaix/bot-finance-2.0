import { describe, expect, it } from 'vitest';
import { ajustarHabil, cicloTarjeta, corteDelMes, cortes, fechaPago, interesEstimado } from '../src/lib/v2/ciclos';
import type { Cuenta, Movimiento } from '../src/lib/v2/model';

const credito = (over: Partial<NonNullable<Cuenta['credito']>> = {}): NonNullable<Cuenta['credito']> => ({
  limiteCentavos: 1_000_000,
  diaCorte: 15,
  diaPago: 5,
  ajustePago: 'siguiente_habil',
  diasAviso: [5, 2, 0],
  ...over,
});

const visa = (over: Partial<Cuenta> = {}): Cuenta => ({
  id: 'visa',
  nombre: 'Visa',
  tipo: 'credito',
  entidadId: null,
  terminaciones: [],
  alias: [],
  semillaCentavos: 0,
  asOf: '2026-10-01',
  estimada: false,
  activa: true,
  credito: credito(),
  ...over,
});

const mov = (fecha: string, montoCentavos: number, origen: string | null, destino: string | null): Movimiento => ({
  fecha,
  montoCentavos,
  tipo: origen && destino ? 'transferencia' : 'gasto',
  origen,
  destino,
  categoria: 'x',
  descripcion: '',
  cuentaFuente: 'usuario',
});

describe('fechas de corte y pago', () => {
  it('corte el 31 en febrero: último día, en año bisiesto y normal', () => {
    expect(corteDelMes(31, '2028-02-10')).toBe('2028-02-29');
    expect(corteDelMes(31, '2027-02-10')).toBe('2027-02-28');
  });

  it('último y próximo corte según el día de hoy', () => {
    expect(cortes(15, '2026-11-22')).toEqual({ ultimo: '2026-11-15', proximo: '2026-12-15' });
    expect(cortes(15, '2026-11-10')).toEqual({ ultimo: '2026-10-15', proximo: '2026-11-15' });
    expect(cortes(15, '2026-11-15')).toEqual({ ultimo: '2026-11-15', proximo: '2026-12-15' });
  });

  it('diaPago menor que diaCorte: el pago cae el mes siguiente; mayor: el mismo mes', () => {
    expect(fechaPago(credito({ diaCorte: 15, diaPago: 5, ajustePago: 'ninguno' }), '2026-11-15')).toBe('2026-12-05');
    expect(fechaPago(credito({ diaCorte: 5, diaPago: 25, ajustePago: 'ninguno' }), '2026-11-05')).toBe('2026-11-25');
  });

  it('ajuste a día hábil (2026-12-05 es sábado)', () => {
    expect(ajustarHabil('2026-12-05', 'siguiente_habil')).toBe('2026-12-07');
    expect(ajustarHabil('2026-12-05', 'anterior_habil')).toBe('2026-12-04');
    expect(ajustarHabil('2026-12-05', 'ninguno')).toBe('2026-12-05');
  });
});

describe('ciclo de la tarjeta', () => {
  const movs = [
    mov('2026-11-03', 300_000, 'visa', null), // compra antes del corte del 15-nov
    mov('2026-11-20', 50_000, 'visa', null), // compra del periodo siguiente
    mov('2026-11-25', 100_000, 'bi', 'visa'), // pago parcial
  ];

  it('deuda al corte, pago parcial, pendiente y consumo del periodo', () => {
    const c = cicloTarjeta(visa(), movs, '2026-11-26')!;
    expect(c).toMatchObject({
      ultimoCorte: '2026-11-15',
      proximoCorte: '2026-12-15',
      fechaPago: '2026-12-07',
      deudaAlCorte: 300_000,
      pagado: 100_000,
      pendiente: 200_000,
      consumoPeriodo: 50_000,
      deudaActual: 250_000,
      interesEstimado: null,
      aproximado: false,
    });
  });

  it('interés estimado con tasa mensual o anual equivalente', () => {
    expect(interesEstimado(100_000, { tasaBps: 350, periodo: 'mensual' })).toBe(3_500);
    expect(interesEstimado(100_000, { tasaBps: 4_200, periodo: 'anual' })).toBe(3_500);
    const c = cicloTarjeta(visa({ credito: credito({ interes: { tasaBps: 350, periodo: 'mensual' } }) }), movs, '2026-11-26')!;
    expect(c.interesEstimado).toBe(7_000);
  });

  it('pagado de más no deja pendiente negativo', () => {
    const c = cicloTarjeta(visa(), [...movs, mov('2026-11-26', 500_000, 'bi', 'visa')], '2026-11-27')!;
    expect(c.pendiente).toBe(0);
  });

  it('semilla posterior al corte: deuda al corte aproximada', () => {
    expect(cicloTarjeta(visa({ asOf: '2026-11-20', semillaCentavos: -80_000 }), [], '2026-11-26')!.aproximado).toBe(true);
  });

  it('una cuenta que no es de crédito no tiene ciclo', () => {
    expect(cicloTarjeta(visa({ tipo: 'banco', credito: undefined }), [], '2026-11-26')).toBeNull();
  });
});
