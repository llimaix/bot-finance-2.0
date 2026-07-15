import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentModel, getModel, getVisionModel } from '../src/lib/ai/llm';

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
