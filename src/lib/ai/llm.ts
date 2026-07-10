import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { config } from '../config';

/**
 * Punto único de acoplamiento con el proveedor de LLM.
 *
 * Cambiar de proveedor NO toca la lógica de negocio: se instala el paquete del
 * provider y se cambian las env vars LLM_PROVIDER / LLM_MODEL (+ la API key
 * del proveedor). Ejemplos:
 *
 *   OpenAI:            pnpm add @ai-sdk/openai
 *     case 'openai':   return createOpenAI()(config.llmModel);
 *
 *   MiniMax / DeepSeek / cualquier API compatible con OpenAI:
 *                      pnpm add @ai-sdk/openai-compatible
 *     case 'minimax':  return createOpenAICompatible({ name: 'minimax',
 *                        baseURL: 'https://api.minimax.io/v1',
 *                        apiKey: process.env.MINIMAX_API_KEY })(config.llmModel);
 *
 *   Google:            pnpm add @ai-sdk/google
 *     case 'google':   return createGoogleGenerativeAI()(config.llmModel);
 */
export function getModel(): LanguageModel {
  switch (config.llmProvider) {
    case 'anthropic':
      // Lee ANTHROPIC_API_KEY del entorno por sí solo.
      return createAnthropic()(config.llmModel);
    default:
      throw new Error(
        `LLM_PROVIDER no soportado: "${config.llmProvider}". Agrega su case en src/lib/ai/llm.ts`,
      );
  }
}
