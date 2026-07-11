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
    });
    expect(parsed.transactions).toHaveLength(2);
  });

  it('acepta "hoy nada" (día sin movimientos explícito)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: true,
    });
    expect(parsed.noMovements).toBe(true);
  });

  it('acepta mensaje sin contenido financiero (saludo)', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: null,
      noMovements: false,
    });
    expect(parsed.transactions).toHaveLength(0);
    expect(parsed.noMovements).toBe(false);
  });

  it('acepta aclaración pendiente', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: '¿Cuánto costó el repuesto?',
      noMovements: false,
    });
    expect(parsed.clarification).toContain('repuesto');
  });

  it('exige el campo noMovements', () => {
    expect(() =>
      parseResultSchema.parse({ transactions: [], clarification: null }),
    ).toThrow();
  });

  it('rechaza categorías y tipos fuera del enum', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'gasto', category: 'viajes', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
      }),
    ).toThrow();
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'compra', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
      }),
    ).toThrow();
  });

  it('rechaza montos no numéricos', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 'Q45', type: 'gasto', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
        noMovements: false,
      }),
    ).toThrow();
  });
});
