import { describe, expect, it } from 'vitest';
import { enforceStatedMethod, registrationWarnings, statedMethod } from '../src/lib/guards';
import type { Transaction } from '../src/lib/types';

let n = 0;
const txn = (partial: Partial<Transaction>): Transaction => ({
  sk: `TXN#2026-07-12#g${++n}`,
  date: '2026-07-12',
  shortId: n,
  amount: 45,
  type: 'gasto',
  category: 'comida',
  method: 'efectivo',
  description: 'almuerzo',
  rawMessage: '',
  createdAt: '',
  ...partial,
});

describe('registrationWarnings', () => {
  it('avisa cuando el nuevo coincide en fecha+monto+categoría con uno existente', () => {
    const existing = [txn({ sk: 'TXN#2026-07-12#viejo', shortId: 1, description: 'almuerzo tacos' })];
    const nuevo = txn({ shortId: 2 });
    const warnings = registrationWarnings([nuevo, ...existing.slice(0, 0)], [...existing, nuevo]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Posible duplicado');
    expect(warnings[0]).toContain('#1');
  });

  it('no se acusa a sí mismo (mismo lote) ni a montos/categorías distintos', () => {
    const a = txn({ shortId: 1, amount: 45 });
    const b = txn({ shortId: 2, amount: 46 });
    const warnings = registrationWarnings([a, b], [a, b]);
    expect(warnings).toHaveLength(0);
  });

  it('avisa de montos grandes', () => {
    const grande = txn({ shortId: 3, amount: 12_000 });
    const warnings = registrationWarnings([grande], [grande]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Monto grande');
  });

  it('gasto con método "na" (cuenta desconocida) pide la cuenta y no afecta saldos', () => {
    const sinCuenta = txn({ shortId: 5, method: 'na', description: 'unas cosas' });
    const warnings = registrationWarnings([sinCuenta], [sinCuenta]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SIN cuenta');
    expect(warnings[0]).toMatch(/crédito.*débito.*efectivo/);
  });

  it('gasto con método real NO dispara el aviso de cuenta desconocida', () => {
    const conCuenta = txn({ shortId: 6, method: 'debito' });
    const warnings = registrationWarnings([conCuenta], [conCuenta]);
    expect(warnings.filter((w) => w.includes('SIN cuenta'))).toHaveLength(0);
  });

  it('incidente 11-jul: mismo monto + descripción similar avisa aunque cambie la categoría', () => {
    const existente = txn({
      sk: 'TXN#2026-07-11#viejo',
      date: '2026-07-11',
      shortId: 1,
      amount: 1000,
      type: 'transferencia',
      category: 'deuda',
      description: 'Préstamo entregado a mamá',
    });
    const duplicado = txn({
      date: '2026-07-11',
      shortId: 7,
      amount: 1000,
      category: 'prestamo',
      description: 'Prestamo a mama',
    });
    const warnings = registrationWarnings([duplicado], [existente, duplicado]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Posible duplicado');
  });

  it('mismo monto con conceptos distintos NO acusa (dos gastos legítimos de Q100)', () => {
    const cerveza = txn({
      sk: 'TXN#2026-07-11#a',
      date: '2026-07-11',
      shortId: 6,
      amount: 100,
      category: 'entretenimiento',
      description: 'Cerveza para compartir con la novia',
    });
    const cena = txn({
      date: '2026-07-11',
      shortId: 8,
      amount: 100,
      category: 'comida',
      description: 'Cena con novia',
    });
    // "cerveza compartir novia" vs "cena novia": similitud baja → sin aviso
    const warnings = registrationWarnings([cena], [cerveza, cena]);
    expect(warnings).toHaveLength(0);
  });
});

/**
 * Frases REALES del chat de Allan. "tarjeta BI" y "tarjeta bi" son la misma
 * cosa y salieron credito dos veces y debito otras dos, según qué ruta
 * atendiera el mensaje. Un prompt no puede garantizar esto: el código sí.
 */
describe('statedMethod: la cuenta que el mensaje NOMBRA manda', () => {
  it.each([
    ['Registra un gasto en tarjeta bi 174 por cerveza', 'debito'],
    ['Se realizó un pago con la tarjeta BI esto por impuesto de factura sat', 'debito'],
    ['Otro gasto por combustible 540 quetzales pago con tarjeta BI', 'debito'],
    ['Otro gasto con tarjeta bi 134 pan para cena con suegros', 'debito'],
    ['gasto en Banco Industrial de 200', 'debito'],
    ['Se realizó este pago con la tarjeta de crédito', 'credito'],
    ['pagué con la BAC 300', 'credito'],
    ['Pago en efectivo desayuno con mi novia 100 quetzales', 'efectivo'],
    ['transferí 500 a Kash', 'transferencia'],
  ])('%s → %s', (text, expected) => {
    expect(statedMethod(text)).toBe(expected);
  });

  it('mayúsculas, minúsculas y tildes dan el MISMO resultado', () => {
    const variantes = ['tarjeta BI', 'tarjeta bi', 'Tarjeta Bi', 'tarjeta de BI'];
    const metodos = new Set(variantes.map(statedMethod));
    expect(metodos).toEqual(new Set(['debito']));
  });

  it('varias cuentas en un mensaje: no decide (el modelo ve cada movimiento)', () => {
    // Caso real: un retiro legítimo menciona la cuenta origen Y el efectivo.
    expect(statedMethod('Se retiró 1000 quetzales de la cuenta BI ahora pasan hacer efectivo')).toBeNull();
  });

  it('sin cuenta nombrada: no inventa', () => {
    expect(statedMethod('gasté 45 en almuerzo')).toBeNull();
  });

  it('no confunde palabras que contienen "bi" ni "bac"', () => {
    expect(statedMethod('compré una bicicleta de 900')).toBeNull();
    expect(statedMethod('pagué el bachillerato')).toBeNull();
  });
});

describe('enforceStatedMethod: corrige al modelo y deja constancia', () => {
  it('el combustible de "tarjeta BI" deja de irse a la tarjeta de crédito', () => {
    const mal = [txn({ method: 'credito', description: 'Combustible pagado con tarjeta BI', amount: 540 })];
    const { txns, corrections } = enforceStatedMethod(mal, 'Otro gasto por combustible 540 quetzales pago con tarjeta BI');
    expect(txns[0]!.method).toBe('debito');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toContain('credito → debito');
  });

  it('si el modelo ya acertó, no toca nada ni genera ruido', () => {
    const bien = [txn({ method: 'debito', description: 'Cerveza' })];
    const { txns, corrections } = enforceStatedMethod(bien, 'Registra un gasto en tarjeta bi 174 por cerveza');
    expect(txns[0]!.method).toBe('debito');
    expect(corrections).toEqual([]);
  });

  it('mensaje ambiguo: respeta lo que decidió el modelo por movimiento', () => {
    const retiro = [txn({ method: 'debito', type: 'retiro', description: 'Retiro de BI' })];
    const { txns, corrections } = enforceStatedMethod(retiro, 'Se retiró 1000 de la cuenta BI ahora pasan hacer efectivo');
    expect(txns[0]!.method).toBe('debito');
    expect(corrections).toEqual([]);
  });
});
