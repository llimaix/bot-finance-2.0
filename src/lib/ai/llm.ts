import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config';

/**
 * Punto único de acoplamiento con el proveedor de LLM.
 *
 * Cambiar de proveedor NO toca la lógica de negocio: solo env vars (en el
 * environment `production` de GitHub) y, si es un proveedor nuevo, su case aquí.
 *
 *   Anthropic (default):  LLM_PROVIDER=anthropic  LLM_MODEL=claude-haiku-4-5
 *                         + secret ANTHROPIC_API_KEY
 *
 *   MiniMax:              LLM_PROVIDER=minimax    LLM_MODEL=MiniMax-M2
 *                         + secret MINIMAX_API_KEY
 *
 *   Otros compatibles con OpenAI (DeepSeek, Kimi, etc.): copiar el case de
 *   minimax cambiando name/baseURL/env de la key.
 *
 *   OpenAI nativo:        pnpm add @ai-sdk/openai
 *     case 'openai':      return createOpenAI()(config.llmModel);
 */
function providerModel(modelId: string): LanguageModel {
  switch (config.llmProvider) {
    case 'anthropic':
      // Lee ANTHROPIC_API_KEY del entorno por sí solo.
      return createAnthropic()(modelId);

    case 'minimax':
      return createOpenAICompatible({
        name: 'minimax',
        // Endpoint internacional compatible con OpenAI (https://platform.minimax.io)
        baseURL: 'https://api.minimax.io/v1',
        apiKey: config.minimaxApiKey,
      })(modelId);

    default:
      throw new Error(
        `LLM_PROVIDER no soportado: "${config.llmProvider}". Agrega su case en src/lib/ai/llm.ts`,
      );
  }
}

/** Modelo de trabajo (parseo de comprobantes, correcciones, narrativas). */
export function getModel(): LanguageModel {
  return providerModel(config.llmModel);
}

/** Modelo del AGENTE conversacional: más capaz, solo para el tool loop. */
export function getAgentModel(): LanguageModel {
  return providerModel(config.llmModelAgent);
}
