import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentModel, getModel, getVisionModel, stripThinking } from '../src/lib/ai/llm';

// El factory no hace llamadas de red al construir el modelo: se puede probar en unit.
afterEach(() => {
  vi.unstubAllEnvs();
});

interface ModelLike {
  modelId: string;
  provider: string;
}

describe('getModel', () => {
  it('anthropic por defecto (incluso con LLM_PROVIDER vacío, como llega de CI)', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    const model = getModel() as ModelLike;
    expect(model.modelId).toBe('claude-haiku-4-5');
    expect(model.provider).toContain('anthropic');
  });

  it('minimax con sus env vars', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', 'MiniMax-M3');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    const model = getModel() as ModelLike;
    expect(model.modelId).toBe('MiniMax-M3');
    expect(model.provider).toContain('minimax');
  });

  it('minimax sin API key falla con mensaje claro', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('MINIMAX_API_KEY', '');
    expect(() => getModel()).toThrow(/MINIMAX_API_KEY/);
  });

  it('proveedor desconocido falla con mensaje claro', () => {
    vi.stubEnv('LLM_PROVIDER', 'chatgpt5000');
    expect(() => getModel()).toThrow(/no soportado/);
  });

  it('minimax sin LLM_MODEL ni LLM_MODEL_AGENT cae a MiniMax-M3 (default por proveedor)', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_MODEL_AGENT', '');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    expect((getModel() as ModelLike).modelId).toBe('MiniMax-M3');
    expect((getAgentModel() as ModelLike).modelId).toBe('MiniMax-M3');
  });
});

describe('getVisionModel', () => {
  it('por defecto sigue al proveedor/modelo principal', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('LLM_PROVIDER_VISION', '');
    vi.stubEnv('LLM_MODEL_VISION', '');
    const model = getVisionModel() as ModelLike;
    expect(model.modelId).toBe('claude-haiku-4-5');
    expect(model.provider).toContain('anthropic');
  });

  it('separable: MiniMax para texto + Anthropic para comprobantes', () => {
    vi.stubEnv('LLM_PROVIDER', 'minimax');
    vi.stubEnv('LLM_MODEL', '');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    vi.stubEnv('LLM_PROVIDER_VISION', 'anthropic');
    vi.stubEnv('LLM_MODEL_VISION', '');
    const vision = getVisionModel() as ModelLike;
    expect(vision.modelId).toBe('claude-haiku-4-5');
    expect(vision.provider).toContain('anthropic');
    // el resto del sistema sigue en minimax
    expect((getModel() as ModelLike).provider).toContain('minimax');
  });
});

describe('stripThinking', () => {
  it('quita el bloque <think> de los modelos razonadores (MiniMax-M3)', () => {
    expect(stripThinking('<think>\nEl usuario saluda. Respondo corto.\n</think>\n\n¡Hola Allan!')).toBe('¡Hola Allan!');
  });

  it('quita múltiples bloques y conserva el resto', () => {
    expect(stripThinking('<think>a</think>Listo, registrado.<think>b</think> ¿Algo más?')).toBe('Listo, registrado. ¿Algo más?');
  });

  it('tag sin cerrar (salida truncada): corta desde ahí', () => {
    expect(stripThinking('Anotado 👍\n<think>ahora debería')).toBe('Anotado 👍');
    expect(stripThinking('<think>solo pensamiento truncado')).toBe('');
  });

  it('texto sin tags pasa intacto', () => {
    expect(stripThinking('  Listo, Q45 registrados.  ')).toBe('Listo, Q45 registrados.');
  });

  it('variante con namespace <mm:think> y cierre huérfano', () => {
    expect(stripThinking('<mm:think>razono</mm:think>Listo.')).toBe('Listo.');
    expect(stripThinking('</mm:think>¿Me reenvías la foto?')).toBe('¿Me reenvías la foto?');
    expect(stripThinking('Anotado.<mm:think>truncado sin cierre')).toBe('Anotado.');
  });
});

describe('ANNOUNCE_RE (anuncio sin acción)', () => {
  it('detecta promesas vacías', async () => {
    const { ANNOUNCE_RE } = await import('../src/lib/ai/agent');
    expect(ANNOUNCE_RE.test('⌛ Espera un momento, estoy consultando tus datos.')).toBe(true);
    expect(ANNOUNCE_RE.test('Déjame revisar tus movimientos')).toBe(true);
    expect(ANNOUNCE_RE.test('Voy a consultar tu saldo')).toBe(true);
  });

  it('no confunde respuestas reales', async () => {
    const { ANNOUNCE_RE } = await import('../src/lib/ai/agent');
    expect(ANNOUNCE_RE.test('Tenés Q2,101.01 en BI y Q40 en Banrural.')).toBe(false);
    expect(ANNOUNCE_RE.test('Listo, registré tus Q45 de almuerzo.')).toBe(false);
  });
});
