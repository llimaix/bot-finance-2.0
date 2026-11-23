/**
 * Validación del initData de una Telegram Mini App. PURO.
 *
 * Algoritmo oficial (core.telegram.org/bots/webapps, "Validating data received
 * via the Mini App"):
 *   data_check_string = pares key=value (sin `hash`), ordenados por key, unidos por \n
 *   secret_key        = HMAC_SHA256(key = "WebAppData", msg = bot_token)
 *   hash esperado     = hex(HMAC_SHA256(key = secret_key, msg = data_check_string))
 *
 * Además: auth_date no más viejo que maxAgeSeconds (anti-replay) y el usuario
 * debe ser el único permitido (en chat privado, user.id = chat id).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type InitDataResult =
  | { ok: true; userId: string; firstName: string | null }
  | { ok: false; reason: 'missing' | 'malformed' | 'bad_hash' | 'expired' | 'forbidden_user' };

export function initDataHash(params: URLSearchParams, botToken: string): string {
  const dataCheckString = [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

export function validateInitData(
  initData: string | undefined,
  opts: { botToken: string; allowedUserId: string; maxAgeSeconds: number; nowSeconds: number },
): InitDataResult {
  if (!initData) return { ok: false, reason: 'missing' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[0-9a-f]{64}$/.test(hash) || !Number.isInteger(authDate)) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(initDataHash(params, opts.botToken), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return { ok: false, reason: 'bad_hash' };

  if (opts.nowSeconds - authDate > opts.maxAgeSeconds) return { ok: false, reason: 'expired' };

  let user: { id?: unknown; first_name?: unknown };
  try {
    user = JSON.parse(params.get('user') ?? '') as typeof user;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (String(user.id) !== opts.allowedUserId) return { ok: false, reason: 'forbidden_user' };
  return { ok: true, userId: String(user.id), firstName: typeof user.first_name === 'string' ? user.first_name : null };
}
