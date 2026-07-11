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
  // `||` y no `??`: en CI las vars no configuradas llegan como string vacío.
  get llmProvider() {
    return process.env.LLM_PROVIDER || 'anthropic';
  },
  get llmModel() {
    return process.env.LLM_MODEL || 'claude-haiku-4-5';
  },
  get sttProvider() {
    return process.env.STT_PROVIDER || 'aws';
  },
  /** Solo requerida cuando LLM_PROVIDER=minimax. */
  get minimaxApiKey() {
    return required('MINIMAX_API_KEY');
  },
};
