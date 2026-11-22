import { describe, expect, it } from 'vitest';
import { correctionChangesSchema } from '../src/lib/ai/agent';

const base = { tipo: null, categoria: null, metodo: null, descripcion: null };

describe('correctionChangesSchema (corregir_movimiento)', () => {
  it('acepta un monto positivo o ningún cambio de monto', () => {
    expect(correctionChangesSchema.safeParse({ ...base, monto: 50 }).success).toBe(true);
    expect(correctionChangesSchema.safeParse({ ...base, monto: 0.01 }).success).toBe(true);
    expect(correctionChangesSchema.safeParse({ ...base, monto: null }).success).toBe(true);
  });

  it('rechaza montos negativos: el signo lo da el tipo, no el monto', () => {
    expect(correctionChangesSchema.safeParse({ ...base, monto: -50 }).success).toBe(false);
  });

  it('rechaza el cero, que `??` dejaría pasar y anularía el movimiento', () => {
    expect(correctionChangesSchema.safeParse({ ...base, monto: 0 }).success).toBe(false);
  });

  it('rechaza valores no finitos', () => {
    expect(correctionChangesSchema.safeParse({ ...base, monto: Number.NaN }).success).toBe(false);
    expect(correctionChangesSchema.safeParse({ ...base, monto: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});
