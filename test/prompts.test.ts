import { describe, expect, it } from 'vitest';
import {
  buildAgentSystemPrompt,
  buildCorrectSystemPrompt,
  buildParseSystemPrompt,
  buildReceiptSystemPrompt,
} from '../src/lib/ai/prompts';

/**
 * Las reglas que deciden CUENTA y SIGNO vivían duplicadas en cuatro prompts y
 * divergieron: «"tarjeta de BI" es la de DÉBITO» estaba solo en el de fotos,
 * mientras texto y agente decían «"la tarjeta" = credito». La misma frase salía
 * débito o crédito según la ruta — 2 de 4 veces cada una en producción
 * (31-jul/2-ago). Un prompt que se queda sin la regla no rompe ningún test
 * unitario: falla en silencio, semanas después, en el saldo de Allan.
 */

const ctx = { categories: ['comida', 'transporte'], today: '2026-08-03', weekday: 'lunes' };

const PROMPTS: Array<[string, string]> = [
  ['parse (texto/voz)', buildParseSystemPrompt(ctx)],
  ['receipt (fotos)', buildReceiptSystemPrompt(ctx)],
  ['correct (correcciones)', buildCorrectSystemPrompt(ctx)],
  ['agent (conversacional)', buildAgentSystemPrompt({ today: ctx.today, weekday: ctx.weekday, contextInfo: 'saldos...' })],
];

describe('reglas de clasificación en TODAS las rutas', () => {
  // Se comprueba CONTENIDO del bloque, no que se mencione su nombre: los
  // prompts se refieren a "la Regla de CUENTAS de arriba", así que buscar el
  // título daba verde aunque el bloque no estuviera incluido.
  it.each(PROMPTS)('%s incluye el CUERPO de la regla de CUENTAS', (_name, prompt) => {
    expect(prompt).toContain('SIN nombrar banco');
  });

  it.each(PROMPTS)('%s incluye el CUERPO de la regla de TIPO', (_name, prompt) => {
    expect(prompt).toContain('inverso exacto del retiro');
  });

  // El bug exacto: "tarjeta BI" es de DÉBITO, no de crédito.
  it.each(PROMPTS)('%s dice que la tarjeta del BI es de débito', (_name, prompt) => {
    expect(prompt).toMatch(/tarjeta del BI es de DÉBITO|tarjeta BI.*debito/i);
  });

  it.each(PROMPTS)('%s no contradice la regla mandando "la tarjeta" a crédito sin matizar', (_name, prompt) => {
    // La forma vieja: «"la tarjeta" = credito» a secas, sin exigir que no
    // nombre banco. Eso es lo que empujaba "tarjeta BI" a la BAC.
    expect(prompt).not.toMatch(/"la tarjeta"\s*(sin más contexto)?\s*[=/]\s*credito/i);
    expect(prompt).not.toMatch(/"la tarjeta"\/"la de crédito"\s*=\s*method credito/i);
  });

  it.each(PROMPTS)('%s manda a preguntar (method "na") en vez de adivinar la cuenta', (_name, prompt) => {
    expect(prompt).toMatch(/method "na"/);
  });
});

describe('la regla de cuentas cubre las cuentas reales', () => {
  const prompt = buildParseSystemPrompt(ctx);

  it.each(['BI', 'BAC', 'Banrural', 'Kash', 'efectivo'])('nombra la cuenta %s', (cuenta) => {
    expect(prompt).toContain(cuenta);
  });

  it('distingue "la tarjeta" a secas (BAC) de "tarjeta BI" (débito)', () => {
    expect(prompt).toContain('SIN nombrar banco');
  });
});
