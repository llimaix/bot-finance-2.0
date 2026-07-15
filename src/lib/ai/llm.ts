import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Punto único de acoplamiento con el proveedor de LLM.
 *
 * Cambiar de proveedor NO toca la lógica de negocio: solo env vars (en el
 * environment `production` de GitHub) y, si es un proveedor nuevo, su case aquí.
 *
 *   Anthropic (default):  LLM_PROVIDER=anthropic + secret ANTHROPIC_API_KEY
 *                         (modelos default: haiku para trabajo, sonnet para el agente)
 *
 *   MiniMax:              LLM_PROVIDER=minimax + secret MINIMAX_API_KEY
 *                         (modelo default: MiniMax-M3 para todo — es multimodal,
 *                         cubre también las fotos de comprobantes)
 *
 *   Otros compatibles con OpenAI (DeepSeek, Kimi, etc.): copiar el case de
 *   minimax cambiando name/baseURL/env de la key.
 *
 *   OpenAI nativo:        pnpm add @ai-sdk/openai
 *     case 'openai':      return createOpenAI()(config.llmModel);
 */
function providerModel(provider: string, modelId: string): LanguageModel {
  switch (provider) {
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
        `LLM_PROVIDER no soportado: "${provider}". Agrega su case en src/lib/ai/llm.ts`,
      );
  }
}

/** Modelo de trabajo (parseo, correcciones, narrativas). */
export function getModel(): LanguageModel {
  return providerModel(config.llmProvider, config.llmModel);
}

/** Modelo del AGENTE conversacional: más capaz, solo para el tool loop. */
export function getAgentModel(): LanguageModel {
  return providerModel(config.llmProvider, config.llmModelAgent);
}

/** Modelo de VISIÓN (fotos de comprobantes): separable del principal. */
export function getVisionModel(): LanguageModel {
  return providerModel(config.llmProviderVision, config.llmModelVision);
}

/**
 * Los modelos razonadores servidos por API OpenAI-compatible (MiniMax-M3)
 * devuelven su cadena de pensamiento como <think>...</think> DENTRO del texto.
 * Se quita antes de que cualquier respuesta llegue a Telegram; si el tag quedó
 * sin cerrar (salida truncada), se corta desde ahí.
 */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const unclosed = out.search(/<think>/i);
  if (unclosed >= 0) out = out.slice(0, unclosed);
  return out.trim();
}

/**
 * Registro de consumo por llamada, para responder "¿en qué se van los tokens?"
 * desde CloudWatch Logs Insights sin depender del dashboard del proveedor.
 */
export function logUsage(
  fn: string,
  modelId: string,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
  extra: Record<string, unknown> = {},
): void {
  logger.info('uso LLM', {
    fn,
    model: modelId,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    ...extra,
  });
}
