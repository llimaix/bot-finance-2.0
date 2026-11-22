import { describe, expect, it } from 'vitest';
import type { ConfigSnapshot } from '../src/lib/v2/config';
import type { Cuenta } from '../src/lib/v2/model';
import { extraerTerminaciones, resolverCuenta } from '../src/lib/v2/resolver';

const credito = { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, ajustePago: 'siguiente_habil', diasAviso: [] } as Cuenta['credito'];
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
  entidades: [
    { id: 'bi', nombre: 'Banco Industrial', alias: ['bi', 'el industrial'] },
    { id: 'bac', nombre: 'BAC', alias: ['bac', 'credomatic'] },
    { id: 'banrural', nombre: 'Banrural', alias: ['banrural'] },
  ],
  cuentas: [
    cuenta({ id: 'bi-debito', nombre: 'BI Débito', tipo: 'banco', entidadId: 'bi', terminaciones: ['2222'] }),
    cuenta({ id: 'bi-mastercard', nombre: 'Mastercard BI', tipo: 'credito', entidadId: 'bi', terminaciones: ['3333'], credito }),
    cuenta({ id: 'bac-visa', nombre: 'Visa BAC', tipo: 'credito', entidadId: 'bac', terminaciones: ['1111'], alias: ['la visa'], credito }),
    cuenta({ id: 'banrural-ahorro', nombre: 'Ahorro Banrural', tipo: 'banco', entidadId: 'banrural' }),
    cuenta({ id: 'efectivo', nombre: 'Efectivo', tipo: 'efectivo', alias: ['cash'] }),
    cuenta({ id: 'vieja', nombre: 'Visa vieja', tipo: 'credito', entidadId: 'bac', terminaciones: ['9999'], credito, activa: false }),
  ],
};

const r = (texto: string, img: string | null = null) => resolverCuenta(texto, SNAP, img);

describe('terminación con contexto', () => {
  it('"termina en 1111" impone la cuenta', () => {
    expect(r('gasté Q200 con la que termina en 1111')).toEqual({ tipo: 'cuenta', cuentaId: 'bac-visa', fuente: 'terminacion' });
  });

  it('acepta las formas habituales de escribirla', () => {
    for (const t of ['****1111', 'xxxx1111', '•••• 1111', 'final 1111', 'terminación: 1111', 'terminada en 1111']) {
      expect(extraerTerminaciones(`pago ${t}`), t).toEqual(['1111']);
    }
  });

  it('"gasté 1234 en el súper" NO es una terminación: es un monto', () => {
    expect(extraerTerminaciones('gasté 1234 en el súper')).toEqual([]);
    expect(r('gasté 1234 en el súper')).toEqual({ tipo: 'ninguna' });
  });

  it('la terminación manda sobre el alias del texto', () => {
    expect(r('con la visa, la que termina en 2222')).toMatchObject({ cuentaId: 'bi-debito', fuente: 'terminacion' });
  });

  it('una terminación desconocida se señala para preguntar y aprenderla', () => {
    expect(r('termina en 4444')).toEqual({ tipo: 'terminacion_desconocida', terminacion: '4444' });
  });

  it('una cuenta cerrada no se impone por su terminación', () => {
    expect(r('termina en 9999')).toEqual({ tipo: 'terminacion_desconocida', terminacion: '9999' });
  });
});

describe('terminación leída de una imagen (wallet, voucher, notificación)', () => {
  it('impone la cuenta sin necesidad de texto', () => {
    expect(r('', '3333')).toEqual({ tipo: 'cuenta', cuentaId: 'bi-mastercard', fuente: 'terminacion' });
  });

  it('manda sobre lo que diga el pie de foto', () => {
    expect(r('con la visa', '2222')).toMatchObject({ cuentaId: 'bi-debito' });
  });
});

describe('alias de la cuenta y de la entidad', () => {
  it('alias propio de la cuenta', () => {
    expect(r('Q50 de gasolina con la visa')).toEqual({ tipo: 'cuenta', cuentaId: 'bac-visa', fuente: 'alias' });
  });

  it('entidad con una sola cuenta activa', () => {
    expect(r('pagué la luz desde banrural')).toMatchObject({ cuentaId: 'banrural-ahorro', fuente: 'alias' });
  });

  it('entidad por su nombre completo o por un alias, sin importar mayúsculas ni tildes', () => {
    expect(r('con el BANCO INDUSTRIAL a crédito')).toMatchObject({ cuentaId: 'bi-mastercard' });
    expect(r('con el industrial, débito')).toMatchObject({ cuentaId: 'bi-debito' });
  });

  it('"BI" sin crédito ni débito es ambiguo: se pregunta', () => {
    expect(r('gasté Q100 con BI')).toEqual({ tipo: 'ambigua', candidatas: ['bi-debito', 'bi-mastercard'] });
  });

  it('"tarjeta" sola NO decide crédito (la tarjeta del BI puede ser de débito)', () => {
    expect(r('con la tarjeta de BI')).toMatchObject({ tipo: 'ambigua' });
  });

  it('no confunde un alias con parte de otra palabra', () => {
    // "bi" no debe coincidir dentro de "bicicleta"
    expect(r('compré una bicicleta')).toEqual({ tipo: 'ninguna' });
  });

  it('las cuentas cerradas no son candidatas', () => {
    expect(r('con la credomatic a crédito')).toEqual({ tipo: 'cuenta', cuentaId: 'bac-visa', fuente: 'alias' });
  });

  it('sin pistas, no impone nada', () => {
    expect(r('almuerzo Q45')).toEqual({ tipo: 'ninguna' });
  });
});
