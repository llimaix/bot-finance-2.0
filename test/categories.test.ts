import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORY_EMOJI, emojiMapFrom, resolveCategory, slugifyCategory } from '../src/lib/categories';
import type { CategoryRecord } from '../src/lib/types';

const record = (name: string, emoji = '❔'): CategoryRecord => ({
  name,
  emoji,
  source: 'seed',
  createdAt: '2026-07-10T00:00:00Z',
});

describe('slugifyCategory', () => {
  it('minúsculas, sin tildes, palabras con guion', () => {
    expect(slugifyCategory('Construcción')).toBe('construccion');
    expect(slugifyCategory('Cuidado Personal')).toBe('cuidado-personal');
    expect(slugifyCategory('MASCOTAS')).toBe('mascotas');
  });

  it('limpia emoji, símbolos y espacios sobrantes', () => {
    expect(slugifyCategory('café ☕')).toBe('cafe');
    expect(slugifyCategory('  gym / pesas  ')).toBe('gym-pesas');
    expect(slugifyCategory('niños')).toBe('ninos');
  });

  it('colapsa guiones y recorta longitud', () => {
    expect(slugifyCategory('a - - b')).toBe('a-b');
    expect(slugifyCategory('x'.repeat(60))).toHaveLength(30);
  });
});

describe('resolveCategory', () => {
  const known = new Map([
    ['comida', record('comida', '🍽️')],
    ['construccion', record('construccion', '🧱')],
  ]);

  it('usa la existente aunque venga con tildes o mayúsculas', () => {
    expect(resolveCategory('Comida', known, [])).toEqual({ name: 'comida' });
    expect(resolveCategory('Construcción', known, [])).toEqual({ name: 'construccion' });
  });

  it('crea nueva con el emoji declarado por el LLM', () => {
    const r = resolveCategory('mascotas', known, [{ name: 'Mascotas', emoji: '🐕' }]);
    expect(r).toEqual({ name: 'mascotas', created: { name: 'mascotas', emoji: '🐕' } });
  });

  it('crea nueva con emoji genérico si el LLM no la declaró', () => {
    const r = resolveCategory('gimnasio', known, []);
    expect(r.created).toEqual({ name: 'gimnasio', emoji: DEFAULT_CATEGORY_EMOJI });
  });

  it('categoría vacía o basura cae en otros', () => {
    expect(resolveCategory('☕', known, []).name).toBe('otros');
  });
});

describe('emojiMapFrom', () => {
  it('el catálogo pisa a las semillas y agrega las nuevas', () => {
    const map = emojiMapFrom([record('comida', '🌮'), record('mascotas', '🐕')]);
    expect(map.get('comida')).toBe('🌮');
    expect(map.get('mascotas')).toBe('🐕');
    expect(map.get('transporte')).toBe('🚗'); // semilla intacta
  });
});
