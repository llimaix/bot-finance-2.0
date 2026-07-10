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
    });
    expect(parsed.transactions).toHaveLength(2);
  });

  it('acepta día sin movimientos con aclaración', () => {
    const parsed = parseResultSchema.parse({
      transactions: [],
      clarification: '¿Cuánto costó el repuesto?',
    });
    expect(parsed.clarification).toContain('repuesto');
  });

  it('rechaza categorías y tipos fuera del enum', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'gasto', category: 'viajes', method: 'efectivo', description: 'x' }],
        clarification: null,
      }),
    ).toThrow();
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 45, type: 'compra', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
      }),
    ).toThrow();
  });

  it('rechaza montos no numéricos', () => {
    expect(() =>
      parseResultSchema.parse({
        transactions: [{ amount: 'Q45', type: 'gasto', category: 'comida', method: 'efectivo', description: 'x' }],
        clarification: null,
      }),
    ).toThrow();
  });
});
