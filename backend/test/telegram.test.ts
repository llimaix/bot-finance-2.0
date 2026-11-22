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

describe('fallback a texto plano (incidente 29/30-jul: un "<monto>" literal borró el guardián dos días)', () => {
  const parseError = () =>
    new Response(
      JSON.stringify({
        ok: false,
        description: `Bad Request: can't parse entities: Unsupported start tag "monto" at byte offset 170`,
      }),
      { status: 400 },
    );

  const bodyOf = (call: number) => {
    const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body));
  };

  it('HTML inválido: el mensaje SALE en texto plano en vez de perderse', async () => {
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(ok());
    await expect(
      sendMessage(1, '🛡️ <b>Guardián</b>\n\nAjusta con /saldo efectivo <monto>.'),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = bodyOf(1);
    expect(retry.parse_mode).toBeUndefined();
    expect(retry.text).toBe('🛡️ Guardián\n\nAjusta con /saldo efectivo <monto>.');
  });

  it('el fallback conserva el teclado inline', async () => {
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(ok());
    const keyboard = [[{ text: 'Sí', callback_data: 'bgt:y:comida:500' }]];
    await sendMessage(1, 'roto <monto>', { keyboard });
    expect(bodyOf(1).reply_markup).toEqual({ inline_keyboard: keyboard });
  });

  it('des-escapa entidades al degradar (&amp;lt; vuelve a ser "<")', async () => {
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(ok());
    await sendMessage(1, '<code>/saldo &lt;monto&gt;</code> &amp; ya');
    expect(bodyOf(1).text).toBe('/saldo <monto> & ya');
  });

  it('un 400 que NO es de parseo se propaga (no enmascara otros fallos)', async () => {
    fetchMock.mockResolvedValue(status(400));
    await expect(sendMessage(1, 'hola')).rejects.toThrow('err 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si el reenvío plano también falla, el error sube', async () => {
    fetchMock.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(status(403));
    await expect(sendMessage(1, 'roto <monto>')).rejects.toThrow('err 403');
  });
});
