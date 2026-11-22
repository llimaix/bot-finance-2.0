import { describe, expect, it } from 'vitest';
import { receiptResultSchema } from '../src/lib/ai/schema';
import { cleanTerminacion, extraerTerminaciones } from '../src/lib/v2/resolver';

describe('cleanTerminacion (terminación leída de una imagen)', () => {
  it('acepta 4 dígitos con o sin máscara', () => {
    expect(cleanTerminacion('1111')).toBe('1111');
    expect(cleanTerminacion('•••• 1111')).toBe('1111');
    expect(cleanTerminacion('XXXX-1111')).toBe('1111');
  });

  it('si la visión leyó más dígitos, solo conserva los 4 últimos', () => {
    expect(cleanTerminacion('4111 1111 1111 1234')).toBe('1234');
  });

  it('null si no hay al menos 4 dígitos', () => {
    expect(cleanTerminacion(null)).toBeNull();
    expect(cleanTerminacion('')).toBeNull();
    expect(cleanTerminacion('12')).toBeNull();
    expect(cleanTerminacion('sin tarjeta')).toBeNull();
  });
});

describe('texto que recibe el agente en modo v2', () => {
  // Mismo formato que describeReceiptForAgent en processing.ts.
  const texto = [
    '📷 Comprobante enviado por foto. La lectura de la imagen dice:',
    '- gasto de Q1,234.50: Farmacia Galeno (categoría salud)',
    'Pagado con la tarjeta terminada en 1111.',
  ].join('\n');

  it('la terminación se reconoce y el monto de 4 cifras no se confunde con ella', () => {
    expect(extraerTerminaciones(texto)).toEqual(['1111']);
  });
});

describe('esquema de comprobantes', () => {
  it('incluye terminacion opcional sin romper el resultado existente', () => {
    const base = { transactions: [], clarification: null, noMovements: false, question: null, newCategories: [] };
    expect(receiptResultSchema.safeParse({ ...base, terminacion: null }).success).toBe(true);
    expect(receiptResultSchema.safeParse({ ...base, terminacion: '1111' }).success).toBe(true);
  });
});
