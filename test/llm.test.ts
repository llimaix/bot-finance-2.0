import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '../src/lib/ai/llm';

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
    vi.stubEnv('LLM_MODEL', 'MiniMax-M2');
    vi.stubEnv('MINIMAX_API_KEY', 'test-key');
    const model = getModel() as ModelLike;
    expect(model.modelId).toBe('MiniMax-M2');
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
});
