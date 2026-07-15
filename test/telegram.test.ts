import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/lib/telegram';

const ok = () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
const status = (code: number) =>
  new Response(JSON.stringify({ ok: false, description: `err ${code}` }), { status: code });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('reintentos de Telegram (incidente 15-jul: "fetch failed" tiró una respuesta buena)', () => {
  it('red caída dos veces y recuperada: el mensaje SALE', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok());
    await expect(sendMessage(1, 'hola')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('500 transitorio se reintenta hasta lograr 200', async () => {
    fetchMock.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(ok());
    await expect(sendMessage(1, 'hola')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('red caída persistente: lanza tras agotar intentos', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendMessage(1, 'hola')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('4xx NO se reintenta (error nuestro, no del camino)', async () => {
    fetchMock.mockResolvedValue(status(400));
    await expect(sendMessage(1, 'hola')).rejects.toThrow('err 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
