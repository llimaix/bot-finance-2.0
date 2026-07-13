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
  get llmModel() {
    return process.env.LLM_MODEL || 'claude-haiku-4-5';
  },
  /** Modelo del tool loop del agente: razonamiento superior solo donde importa. */
  get llmModelAgent() {
    return process.env.LLM_MODEL_AGENT || 'claude-sonnet-5';
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
