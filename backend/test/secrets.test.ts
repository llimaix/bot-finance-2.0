import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSecrets, resetSecretsCache } from '../src/lib/secrets';

const TARGETS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ALLOWED_CHAT_ID',
  'ANTHROPIC_API_KEY',
  'MINIMAX_API_KEY',
];

/** Cliente falso: responde según el SecretId pedido y cuenta las llamadas. */
function fakeClient(secrets: Record<string, string | undefined>) {
  const send = vi.fn(async (cmd: { input: { SecretId: string } }) => ({
    SecretString: secrets[cmd.input.SecretId],
  }));
  return { client: { send } as unknown as SecretsManagerClient, send };
}

describe('loadSecrets', () => {
  beforeEach(() => {
    resetSecretsCache();
    for (const name of [...TARGETS, 'TELEGRAM_SECRET_NAME', 'LLM_SECRET_NAME']) vi.stubEnv(name, '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('vuelca las claves del JSON en las variables que espera config', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    vi.stubEnv('LLM_SECRET_NAME', 'proj/llm');
    const { client } = fakeClient({
      'proj/telegram': JSON.stringify({ bot_token: 't', webhook_secret: 'w', allowed_chat_id: '1' }),
      'proj/llm': JSON.stringify({ anthropic_api_key: 'a', minimax_api_key: '' }),
    });

    await loadSecrets(client);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('t');
    expect(process.env.TELEGRAM_WEBHOOK_SECRET).toBe('w');
    expect(process.env.ALLOWED_CHAT_ID).toBe('1');
    expect(process.env.ANTHROPIC_API_KEY).toBe('a');
    expect(process.env.MINIMAX_API_KEY).toBe(''); // vacío en el secreto → no se pisa
  });

  it('recorta espacios y saltos de línea pegados en la consola', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    const { client } = fakeClient({
      'proj/telegram': JSON.stringify({ bot_token: ' t ', webhook_secret: 'w\n', allowed_chat_id: '\t1199338066 ' }),
    });

    await loadSecrets(client);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('t');
    expect(process.env.TELEGRAM_WEBHOOK_SECRET).toBe('w');
    expect(process.env.ALLOWED_CHAT_ID).toBe('1199338066');
  });

  it('ignora valores que quedan vacíos tras recortar', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    const { client } = fakeClient({ 'proj/telegram': JSON.stringify({ bot_token: '   ', allowed_chat_id: '1' }) });

    await loadSecrets(client);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('');
    expect(process.env.ALLOWED_CHAT_ID).toBe('1');
  });

  it('lee cada secreto una sola vez por contenedor', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    const { client, send } = fakeClient({ 'proj/telegram': JSON.stringify({ bot_token: 't' }) });

    await loadSecrets(client);
    await loadSecrets(client);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('respeta las variables que ya existen (local, tests, eval)', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'local');
    const { client } = fakeClient({ 'proj/telegram': JSON.stringify({ bot_token: 'remoto', webhook_secret: 'w' }) });

    await loadSecrets(client);

    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('local');
    expect(process.env.TELEGRAM_WEBHOOK_SECRET).toBe('w');
  });

  it('no llama a Secrets Manager si la Lambda no tiene nombres de secreto', async () => {
    const { client, send } = fakeClient({});

    await loadSecrets(client);

    expect(send).not.toHaveBeenCalled();
  });

  it('falla sin filtrar el contenido si el secreto no es JSON, y reintenta en la siguiente llamada', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    const bad = fakeClient({ 'proj/telegram': 'valor-que-no-debe-aparecer' });

    const error = await loadSecrets(bad.client).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('proj/telegram');
    expect((error as Error).message).not.toContain('valor-que-no-debe-aparecer');

    const good = fakeClient({ 'proj/telegram': JSON.stringify({ bot_token: 't' }) });
    await loadSecrets(good.client);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('t');
  });

  it('falla si el secreto existe pero no tiene valor cargado', async () => {
    vi.stubEnv('TELEGRAM_SECRET_NAME', 'proj/telegram');
    const { client } = fakeClient({ 'proj/telegram': undefined });

    await expect(loadSecrets(client)).rejects.toThrow('no tiene valor cargado');
  });
});
