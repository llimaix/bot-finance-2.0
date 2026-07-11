import { describe, expect, it } from 'vitest';
import { parseResultSchema } from '../src/lib/ai/schema';

describe('parseResultSchema', () => {
  it('acepta el formato del system prompt', () => {
    const parsed = parseResultSchema.parse({
      transactions: [
        { amount: 45, type: 'gasto', category: 'comida', method: 'efectivo', description: 'almuerzo' },
        { amount: 1500, type: 'deposito', category: 'ahorro', method: 'na', description: 'depósito ahorro' },
      ],
      clarification: null,
      noMovements: false,
      newCategories: [],
    });
    expect(parsed.transactions).toHaveLength(2);
  });

  it('acepta categorías nuevas declaradas (catálogo abierto)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [
        { amount: 200, type: 'gasto', category: 'mascotas', method: 'efectivo', description: 'comida del perro' },
      ],
      clarification: null,
      noMovements: false,
      newCategories: [{ name: 'mascotas', emoji: '🐕' }],
    });
    expect(parsed.newCategories[0]?.name).toBe('mascotas');
  });

  it('acepta "hoy nada" (día sin movimientos explícito)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: true,
      newCategories: [],
    });
    expect(parsed.noMovements).toBe(true);
  });

  it('acepta mensaje sin contenido financiero (saludo)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: false,
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
        transactions: [{ amount: 45, type: 'gasto', category: 'viajes', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
        newCategories: [{ name: 'viajes', emoji: '✈️' }],
      }),
    ).not.toThrow();
    // type inventado: inválido
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'compra', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
    // method inventado: inválido
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'gasto', category: 'comida', method: 'cheque', description: 'x' }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
  });

  it('rechaza montos no numéricos', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 'Q45', type: 'gasto', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
        newCategories: [],
      }),
    ).toThrow();
  });
});
