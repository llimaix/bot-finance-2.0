function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** Getters perezosos: las Lambdas fallan al primer uso si falta algo, y los tests
 *  de lógica pura no necesitan tener el entorno completo. */
export const config = {
  get tableName() {
    return required('TABLE_NAME');
  },
  get telegramBotToken() {
    return required('TELEGRAM_BOT_TOKEN');
  },
  get telegramWebhookSecret() {
    return required('TELEGRAM_WEBHOOK_SECRET');
  },
  get allowedChatId() {
    return required('ALLOWED_CHAT_ID');
  },
  /** Nombre de la Lambda processor a la que el webhook delega (async). */
  get processorFunctionName() {
    return required('PROCESSOR_FUNCTION_NAME');
  },
  // `||` y no `??`: en CI las vars no configuradas llegan como string vacío.
  get llmProvider() {
    return process.env.LLM_PROVIDER || 'anthropic';
  },
  // Defaults POR PROVEEDOR: cambiar a MiniMax es UNA variable (LLM_PROVIDER),
  // los modelos caen solos al correcto (olvidar LLM_MODEL_AGENT mandaba a pedir
  // "claude-sonnet-5" al API de MiniMax). MiniMax-M3 (may-2026): multimodal
  // (texto+imagen), 1M de contexto, agéntico — sirve para TODO, visión incluida.
  get llmModel() {
    return process.env.LLM_MODEL || (this.llmProvider === 'minimax' ? 'MiniMax-M3' : 'claude-haiku-4-5');
  },
  /** Modelo del tool loop del agente: razonamiento superior solo donde importa. */
  get llmModelAgent() {
    return (
      process.env.LLM_MODEL_AGENT || (this.llmProvider === 'minimax' ? 'MiniMax-M3' : 'claude-sonnet-5')
    );
  },
  /** Proveedor/modelo de VISIÓN (comprobantes): separable del principal por si
   *  el modelo de texto elegido no acepta imágenes (p.ej. MiniMax-M2). */
  get llmProviderVision() {
    return process.env.LLM_PROVIDER_VISION || this.llmProvider;
  },
  get llmModelVision() {
    if (process.env.LLM_MODEL_VISION) return process.env.LLM_MODEL_VISION;
    if (this.llmProviderVision === this.llmProvider) return this.llmModel;
    return this.llmProviderVision === 'minimax' ? 'MiniMax-M3' : 'claude-haiku-4-5';
  },
  get sttProvider() {
    return process.env.STT_PROVIDER || 'aws';
  },
  /** Tipo de cambio USD→GTQ para suscripciones internacionales (convención de la ingesta). */
  get usdGtqRate() {
    return Number(process.env.USD_GTQ_RATE || '7.80');
  },
  /** Solo requerida cuando LLM_PROVIDER=minimax. */
  get minimaxApiKey() {
    return required('MINIMAX_API_KEY');
  },
};
