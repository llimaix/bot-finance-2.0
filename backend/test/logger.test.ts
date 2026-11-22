import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger, redact } from '../src/lib/logger';

describe('redact (H2: sin datos financieros en los logs)', () => {
  it('resume texto y montos del usuario sin exponer el valor', () => {
    const out = redact({
      userText: 'gasté Q45 en almuerzo',
      reply: '✅ Registrado #1',
      amount: 45,
      parsed: [{ amount: 45 }, { amount: 10 }],
      text: 'mi salario es Q8,000',
    });
    expect(out).toEqual({
      userText: '[redactado: 21 car.]',
      reply: '[redactado: 15 car.]',
      amount: '[redactado: number]',
      parsed: '[redactado: 2 elementos]',
      text: '[redactado: 20 car.]',
    });
  });

  it('conserva identificadores, conteos y errores para diagnosticar', () => {
    const data = { updateId: 42, senderId: 1, registered: 2, steps: 3, error: 'timeout', category: 'comida' };
    expect(redact(data)).toEqual(data);
  });

  it('deja null y undefined como están', () => {
    expect(redact({ clarification: null, text: undefined })).toEqual({ clarification: null, text: undefined });
  });
});

describe('logger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('la línea emitida no contiene el texto ni el monto', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('agente completado', { userText: 'pagué Q1,234.56 de la tarjeta', amount: 1234.56, steps: 2 });

    const line = spy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('Q1,234.56');
    expect(line).not.toContain('1234.56');
    expect(JSON.parse(line)).toMatchObject({ level: 'info', msg: 'agente completado', steps: 2 });
  });
});
