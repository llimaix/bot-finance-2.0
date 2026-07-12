import { slugifyCategory } from './categories';
import type { Transaction } from './types';

export interface SearchFilters {
  categoria?: string | null;
  /** Búsqueda en la descripción, insensible a mayúsculas y tildes. */
  texto?: string | null;
}

const MAX_LISTED = 20;

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Filtra y agrega movimientos para la herramienta buscar_movimientos.
 * Todo el cálculo ocurre aquí (código); el LLM solo narra el resultado.
 */
export function summarizeSearch(txns: ReadonlyArray<Transaction>, filters: SearchFilters) {
  const categoria = filters.categoria ? slugifyCategory(filters.categoria) : null;
  const texto = filters.texto ? normalize(filters.texto) : null;

  const matches = txns.filter((t) => {
    if (categoria && t.category !== categoria) return false;
    if (texto && !normalize(t.description).includes(texto)) return false;
    return true;
  });

  const porTipo: Record<string, { total: number; count: number }> = {};
  const porCategoria: Record<string, number> = {};
  for (const t of matches) {
    const tipo = (porTipo[t.type] ??= { total: 0, count: 0 });
    tipo.total = round2(tipo.total + t.amount);
    tipo.count += 1;
    if (t.type === 'gasto') porCategoria[t.category] = round2((porCategoria[t.category] ?? 0) + t.amount);
  }

  const ordered = [...matches].sort((a, b) => b.date.localeCompare(a.date));
  return {
    encontrados: matches.length,
    porTipo,
    gastosPorCategoria: Object.fromEntries(
      Object.entries(porCategoria).sort(([, a], [, b]) => b - a),
    ),
    movimientos: ordered.slice(0, MAX_LISTED).map((t) => ({
      fecha: t.date,
      monto: t.amount,
      tipo: t.type,
      categoria: t.category,
      metodo: t.method,
      descripcion: t.description,
    })),
    ...(matches.length > MAX_LISTED
      ? { nota: `Mostrando los ${MAX_LISTED} más recientes de ${matches.length}.` }
      : {}),
  };
}
