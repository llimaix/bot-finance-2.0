import { describe, expect, it } from 'vitest';
import { needsDeterministicRegister, toolUsage } from '../src/lib/ai/agent';

const attempt = (...toolNames: string[]) => ({
  steps: [{ toolCalls: toolNames.map((toolName) => ({ toolName })) }],
});

describe('toolUsage (M4: detección acumulada entre intentos)', () => {
  it('una escritura en el primer intento cuenta aunque el reintento no escriba', () => {
    const usage = toolUsage([attempt('corregir_movimiento'), attempt()]);
    expect(usage).toEqual({ usedAnyTool: true, usedWriteTool: true });
    // Y por tanto la red de seguridad NO registra un duplicado.
    expect(needsDeterministicRegister(usage.usedWriteTool, 'pagué Q50 de luz')).toBe(false);
  });

  it('una consulta no cuenta como escritura', () => {
    expect(toolUsage([attempt('consultar_datos', 'buscar_movimientos')])).toEqual({ usedAnyTool: true, usedWriteTool: false });
  });

  it('sin herramientas en ningún intento', () => {
    expect(toolUsage([attempt(), { steps: [] }, {}])).toEqual({ usedAnyTool: false, usedWriteTool: false });
  });

  it('la escritura del reintento también cuenta', () => {
    expect(toolUsage([attempt(), attempt('registrar_movimientos')]).usedWriteTool).toBe(true);
  });
});
