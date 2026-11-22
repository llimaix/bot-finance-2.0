/**
 * Persistencia de la configuración v2 (IO). Claves:
 *   CTA#<id>   cuenta      (no ACC#: ese prefijo es del modelo v1 y se cruzarían)
 *   BNK#<id>   entidad bancaria
 *   UNDO#<id>  versión anterior de lo guardado, para ↩️ Deshacer (TTL 24 h)
 */
import { ulid } from 'ulid';
import { deleteItemBySk, getItemBySk, putItemBySk, queryItemsByPrefix } from '../dynamo';
import { logger } from '../logger';
import type { ConfigSnapshot } from './config';
import { cuentaSchema, entidadSchema } from './model';
import type { Cuenta, EntidadBancaria } from './model';

export const UNDO_TTL_MS = 24 * 3600 * 1000;

const withoutKeys = ({ PK: _pk, SK: _sk, ...rest }: Record<string, unknown>) => rest;

export async function loadSnapshot(): Promise<ConfigSnapshot> {
  const [rawCuentas, rawEntidades] = await Promise.all([queryItemsByPrefix('CTA#'), queryItemsByPrefix('BNK#')]);
  const cuentas: Cuenta[] = [];
  for (const raw of rawCuentas) {
    const parsed = cuentaSchema.safeParse(withoutKeys(raw));
    if (parsed.success) cuentas.push(parsed.data);
    else logger.error('cuenta v2 inválida en la tabla', { sk: raw.SK });
  }
  const entidades: EntidadBancaria[] = [];
  for (const raw of rawEntidades) {
    const parsed = entidadSchema.safeParse(withoutKeys(raw));
    if (parsed.success) entidades.push(parsed.data);
    else logger.error('entidad v2 inválida en la tabla', { sk: raw.SK });
  }
  return { cuentas, entidades };
}

export const cuentaSk = (id: string): string => `CTA#${id}`;
export const entidadSk = (id: string): string => `BNK#${id}`;

/** Un item a escribir y su versión anterior (null = no existía: deshacer lo borra). */
interface Write {
  sk: string;
  value: Record<string, unknown>;
  previous: Record<string, unknown> | null;
}

/**
 * Guarda los items y registra cómo deshacerlos. Devuelve el id de deshacer.
 * Se guarda primero el UNDO: si una escritura fallara a medias, el deshacer
 * sigue sabiendo qué restaurar.
 */
export async function saveWithUndo(writes: ReadonlyArray<Write>): Promise<string> {
  const undoId = ulid();
  const expiresAt = Date.now() + UNDO_TTL_MS;
  await putItemBySk(`UNDO#${undoId}`, {
    ops: writes.map((w) => ({ sk: w.sk, previous: w.previous })),
    expiresAt,
    ttl: Math.floor(expiresAt / 1000),
  });
  for (const w of writes) await putItemBySk(w.sk, w.value);
  return undoId;
}

export function cuentaWrite(cuenta: Cuenta, previous: Cuenta | null): Write {
  return { sk: cuentaSk(cuenta.id), value: { ...cuenta }, previous: previous ? { ...previous } : null };
}

export function entidadWrite(entidad: EntidadBancaria, previous: EntidadBancaria | null): Write {
  return { sk: entidadSk(entidad.id), value: { ...entidad }, previous: previous ? { ...previous } : null };
}

/** ↩️ Deshacer. false si no existe o caducó (24 h). Solo se puede usar una vez. */
export async function applyUndo(undoId: string): Promise<boolean> {
  const sk = `UNDO#${undoId}`;
  const item = await getItemBySk(sk);
  if (!item || typeof item.expiresAt !== 'number' || Date.now() >= item.expiresAt) return false;

  const ops = (item.ops as Array<{ sk: string; previous: Record<string, unknown> | null }>) ?? [];
  for (const op of ops) {
    if (op.previous) await putItemBySk(op.sk, op.previous);
    else await deleteItemBySk(op.sk);
  }
  await deleteItemBySk(sk);
  logger.info('configuración deshecha', { undoId, items: ops.length });
  return true;
}
