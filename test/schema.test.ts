import { describe, expect, it } from 'vitest';
import { parseResultSchema } from '../src/lib/ai/schema';

describe('parseResultSchema', () => {
  it('acepta el formato del system prompt', () => {
    const parsed = parseResultSchema.parse({
      transactions: [
        { amount: 45, currency: 'GTQ', type: 'gasto', category: 'comida', method: 'efectivo', description: 'almuerzo', date: null },
        { amount: 1500, currency: 'GTQ', type: 'deposito', category: 'ahorro', method: 'na', description: 'depósito ahorro', date: null },
      ],
      clarification: null,
      noMovements: false,
      question: null,
      newCategories: [],
    });
    expect(parsed.transactions).toHaveLength(2);
  });

  it('acepta categorías nuevas declaradas (catálogo abierto)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [
        { amount: 200, currency: 'GTQ', type: 'gasto', category: 'mascotas', method: 'efectivo', description: 'comida del perro', date: null },
      ],
      clarification: null,
      noMovements: false,
      question: null,
      newCategories: [{ name: 'mascotas', emoji: '🐕' }],
    });
    expect(parsed.newCategories[0]?.name).toBe('mascotas');
  });

  it('acepta "hoy nada" (día sin movimientos explícito)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: true,
      question: null,
      newCategories: [],
    });
    expect(parsed.noMovements).toBe(true);
  });

  it('acepta mensaje sin contenido financiero (saludo)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: false,
      question: null,
      newCategories: [],
    });
    expect(parsed.transactions).toHaveLength(0);
    expect(parsed.noMovements).toBe(false);
  });

  it('acepta aclaración pendiente', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: '¿Cuánto costó el repuesto?',
      noMovements: false,
      question: null,
      newCategories: [],
    });
    expect(parsed.clarification).toContain('repuesto');
  });

  it('exige noMovements y newCategories', () => {
    expect(() =>
      parseResultSchema.parse({ transactions: [], clarification: null, newCategories: [] }),
    ).toThrow();
    expect(() =>
      parseResultSchema.parse({ transactions: [], clarification: null, noMovements: false }),
    ).toThrow();
  });

  it('la categoría es abierta, pero type y method siguen cerrados', () => {
    // categoría fuera del catálogo semilla: VÁLIDA (catálogo dinámico)
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, currency: 'GTQ', type: 'gasto', category: 'viajes', method: 'efectivo', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        question: null,
        newCategories: [{ name: 'viajes', emoji: '✈️' }],
      }),
    ).not.toThrow();
    // type inventado: inválido
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, currency: 'GTQ', type: 'compra', category: 'comida', method: 'efectivo', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
    // method inventado: inválido
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, currency: 'GTQ', type: 'gasto', category: 'comida', method: 'cheque', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
  });

  it('currency: acepta USD, exige el campo y rechaza otras monedas', () => {
    const usd = parseResultSchema.parse({
      transactions: [{ amount: 100, currency: 'USD', type: 'gasto', category: 'suscripciones', method: 'credito', description: 'Anthropic Max', date: null }],
      clarification: null,
      noMovements: false,
      question: null,
      newCategories: [],
    });
    expect(usd.transactions[0]?.currency).toBe('USD');
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'gasto', category: 'comida', method: 'efectivo', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        question: null,
        newCategories: [],
      }),
    ).toThrow(); // sin currency
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, currency: 'EUR', type: 'gasto', category: 'comida', method: 'efectivo', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        question: null,
        newCategories: [],
      }),
    ).toThrow(); // moneda no soportada
  });

  it('rechaza montos no numéricos', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 'Q45', currency: 'GTQ', type: 'gasto', category: 'comida', method: 'efectivo', description: 'x', date: null }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
  });
});
