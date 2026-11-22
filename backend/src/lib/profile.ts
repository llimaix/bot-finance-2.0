import { getProfile, putProfile } from './dynamo';
import { logger } from './logger';

/**
 * Nombre del usuario para la invocación en curso.
 *
 * Los handlers que usan prompts llaman a loadProfile() al empezar, y los
 * prompts lo leen con currentUserName(). Estado de módulo a propósito, igual
 * que deadline.ts: Lambda procesa UN evento por contenedor a la vez. Se relee
 * en cada invocación, así que un cambio de nombre se ve en el siguiente mensaje.
 */
let userName: string | null = null;

const NAME_MAX_LENGTH = 40;
/** Letras de cualquier idioma (con tildes), espacios, apóstrofo y guion. */
const NAME_RE = /^\p{L}[\p{L}\p{M}' -]*$/u;

/** Limpia y valida un nombre. null si no es un nombre aceptable. */
export function normalizeName(raw: string): string | null {
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) return null;
  return NAME_RE.test(name) ? name : null;
}

export async function loadProfile(): Promise<void> {
  try {
    userName = (await getProfile())?.nombre ?? null;
  } catch (err) {
    // Sin nombre el bot sigue funcionando (trato neutro); no vale la pena fallar.
    userName = null;
    logger.error('no se pudo leer el perfil', { error: String(err) });
  }
}

export function currentUserName(): string | null {
  return userName;
}

/** Solo para tests: fija el nombre sin pasar por DynamoDB. */
export function setCurrentUserNameForTests(name: string | null): void {
  userName = name;
}

/** Valida, guarda y aplica el nombre en la invocación actual. */
export async function changeUserName(raw: string): Promise<{ ok: true; nombre: string } | { ok: false; error: string }> {
  const nombre = normalizeName(raw);
  if (!nombre) {
    return {
      ok: false,
      error: `Nombre no válido: usa solo letras, espacios, apóstrofo o guion (máximo ${NAME_MAX_LENGTH} caracteres).`,
    };
  }
  await putProfile({ nombre, actualizadoEn: new Date().toISOString() });
  userName = nombre;
  return { ok: true, nombre };
}
