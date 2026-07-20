import { describe, expect, it } from 'vitest';
import { registrationWarnings } from '../src/lib/guards';
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
