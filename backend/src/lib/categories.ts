import type { CategoryRecord } from './types';

export const DEFAULT_CATEGORY_EMOJI = '🏷️';

/** Emojis de las categorías semilla (y fallback para movimientos viejos sin emoji). */
export const SEED_CATEGORY_EMOJI: Record<string, string> = {
  comida: '🍽️',
  supermercado: '🛒',
  transporte: '🚗',
  hogar: '🏠',
  herramientas: '🔧',
  construccion: '🧱',
  salud: '💊',
  educacion: '📚',
  entretenimiento: '🎬',
  ropa: '👕',
  regalos: '🎁',
  servicios: '💡',
  suscripciones: '📺',
  ahorro: '🐷',
  inversion: '📈',
  deuda: '💳',
  otros: '📦',
};

const COMBINING_MARKS = /\p{M}/gu;
const INVALID_CHARS = /[^a-z0-9\s-]/g;

/**
 * Normaliza el nombre de una categoría a slug: minúsculas, sin tildes,
 * palabras unidas por guion. "Cuidado Personal" → "cuidado-personal".
 */
export function slugifyCategory(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(INVALID_CHARS, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

export interface ResolvedCategory {
  name: string;
  /** Presente solo si la categoría no existía y hay que crearla. */
  created?: { name: string; emoji: string };
}

/**
 * Resuelve la categoría que devolvió el LLM contra la base de conocimientos:
 * - si el slug ya existe, se usa la existente (aunque venga con tildes/mayúsculas);
 * - si no existe, se crea con el emoji que el LLM declaró en newCategories
 *   (o uno genérico si no lo declaró).
 */
export function resolveCategory(
  raw: string,
  known: ReadonlyMap<string, CategoryRecord>,
  declaredNew: ReadonlyArray<{ name: string; emoji: string }>,
): ResolvedCategory {
  const slug = slugifyCategory(raw) || 'otros';
  if (known.has(slug)) return { name: slug };

  const declared = declaredNew.find((d) => slugifyCategory(d.name) === slug);
  const emoji = declared?.emoji.trim() || DEFAULT_CATEGORY_EMOJI;
  return { name: slug, created: { name: slug, emoji } };
}

/** Mapa nombre→emoji para renderizar, combinando catálogo y semillas. */
export function emojiMapFrom(categories: ReadonlyArray<CategoryRecord>): Map<string, string> {
  const map = new Map<string, string>(Object.entries(SEED_CATEGORY_EMOJI));
  for (const c of categories) map.set(c.name, c.emoji);
  return map;
}
