import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * Secretos en AWS Secrets Manager → variables de entorno que espera `config.ts`.
 *
 * Terraform solo inyecta el NOMBRE de cada secreto (p. ej. TELEGRAM_SECRET_NAME);
 * el valor se lee aquí en tiempo de ejecución, una vez por contenedor, y nunca
 * pasa por la configuración de la Lambda, el plan ni el state.
 *
 * Si una variable destino ya existe (desarrollo local, tests, eval), se respeta.
 */
const SECRET_MAP: Record<string, Record<string, string>> = {
  TELEGRAM_SECRET_NAME: {
    bot_token: 'TELEGRAM_BOT_TOKEN',
    webhook_secret: 'TELEGRAM_WEBHOOK_SECRET',
    allowed_chat_id: 'ALLOWED_CHAT_ID',
  },
  LLM_SECRET_NAME: {
    anthropic_api_key: 'ANTHROPIC_API_KEY',
    minimax_api_key: 'MINIMAX_API_KEY',
  },
};

let loading: Promise<void> | undefined;

/** Carga los secretos una sola vez por contenedor; si falla, el siguiente intento reintenta. */
export function loadSecrets(client: SecretsManagerClient = new SecretsManagerClient({})): Promise<void> {
  loading ??= hydrate(client).catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** Solo para tests: olvida la caché del contenedor. */
export function resetSecretsCache(): void {
  loading = undefined;
}

async function hydrate(client: SecretsManagerClient): Promise<void> {
  await Promise.all(
    Object.entries(SECRET_MAP).map(async ([nameVar, keys]) => {
      const secretId = process.env[nameVar];
      if (!secretId) return; // esta Lambda no usa ese secreto, o el entorno ya trae los valores
      if (Object.values(keys).every((target) => process.env[target])) return;

      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!res.SecretString) throw new Error(`El secreto ${secretId} no tiene valor cargado`);

      let values: Record<string, unknown>;
      try {
        values = JSON.parse(res.SecretString) as Record<string, unknown>;
      } catch {
        // Sin incluir el contenido: el mensaje de error no debe filtrar el secreto.
        throw new Error(`El secreto ${secretId} no es un JSON válido`);
      }

      for (const [key, target] of Object.entries(keys)) {
        // trim: un espacio o salto de línea pegado en la consola no debe
        // romper la comparación del chat ni la autenticación del webhook.
        const value = values[key];
        const clean = typeof value === 'string' ? value.trim() : '';
        if (clean !== '' && !process.env[target]) {
          process.env[target] = clean;
        }
      }
    }),
  );
}
