/**
 * Cómo se decide la cuenta de un movimiento (diseño, sección 4). PURO.
 *
 * Precedencia:
 *   1. Terminación con contexto explícito ("termina en 1111", "****1111") o
 *      leída de una imagen. Nunca 4 dígitos sueltos: "gasté 1234" es un monto.
 *   2. Alias o nombre de la cuenta ("la visa").
 *   3. Alias o nombre de la entidad ("BI", "Banco Industrial") → sus cuentas;
 *      si hay varias, se filtra con "crédito"/"débito" del texto.
 *   4. Nada concluyente → el llamador pregunta (o usa la propuesta del modelo,
 *      validada contra las cuentas existentes).
 */
import { normalizeAlias } from './aliases';
import type { ConfigSnapshot } from './config';
import type { Cuenta } from './model';

export type Resolucion =
  | { tipo: 'cuenta'; cuentaId: string; fuente: 'terminacion' | 'alias' }
  /** Hay terminación pero ninguna cuenta la tiene: preguntar a cuál pertenece y aprenderla. */
  | { tipo: 'terminacion_desconocida'; terminacion: string }
  /** Varias cuentas posibles: preguntar con botones. */
  | { tipo: 'ambigua'; candidatas: string[] }
  | { tipo: 'ninguna' };

const CONTEXTO_TERMINACION = [
  /\btermina(?:da|do)?\s+en\s*:?\s*(\d{4})\b/gi,
  /\bterminaci[oó]n\s*:?\s*(\d{4})\b/gi,
  /\bfinal(?:izada)?\s+(?:en\s+)?(\d{4})\b/gi,
  /(?:[*•x]{2,}|\bx{2,})\s?(\d{4})\b/gi,
];

/** Terminaciones con contexto explícito, en orden de aparición y sin repetir. */
export function extraerTerminaciones(texto: string): string[] {
  const found: Array<{ at: number; t: string }> = [];
  for (const re of CONTEXTO_TERMINACION) {
    for (const m of texto.matchAll(re)) found.push({ at: m.index ?? 0, t: m[1]! });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.t))];
}

/** Texto normalizado con espacios en los bordes, para buscar palabras completas. */
const comoPalabras = (texto: string): string => ` ${normalizeAlias(texto).replace(/[^a-z0-9]+/g, ' ').trim()} `;
const mencionaA = (texto: string, nombre: string): boolean => {
  const n = comoPalabras(nombre).trim();
  return n.length > 0 && texto.includes(` ${n} `);
};

function filtrarPorTipo(cuentas: Cuenta[], texto: string): Cuenta[] {
  const credito = /\bcredito\b/.test(texto);
  const debito = /\bdebito\b/.test(texto);
  if (credito === debito) return cuentas; // ninguna o ambas palabras: no filtra
  return cuentas.filter((c) => (credito ? c.tipo === 'credito' : c.tipo !== 'credito'));
}

export function resolverCuenta(
  texto: string,
  snap: ConfigSnapshot,
  terminacionImagen: string | null = null,
): Resolucion {
  const activas = snap.cuentas.filter((c) => c.activa);

  // 1. Terminación (la de la imagen manda: es lo que se ve en el comprobante).
  const terminaciones = [...(terminacionImagen ? [terminacionImagen] : []), ...extraerTerminaciones(texto)];
  for (const t of terminaciones) {
    const cuenta = activas.find((c) => c.terminaciones.includes(t));
    if (cuenta) return { tipo: 'cuenta', cuentaId: cuenta.id, fuente: 'terminacion' };
  }
  if (terminaciones.length > 0) return { tipo: 'terminacion_desconocida', terminacion: terminaciones[0]! };

  const normal = comoPalabras(texto);

  // 2. Alias o nombre de la cuenta.
  const porAlias = activas.filter((c) => [c.nombre, ...c.alias].some((a) => mencionaA(normal, a)));
  if (porAlias.length === 1) return { tipo: 'cuenta', cuentaId: porAlias[0]!.id, fuente: 'alias' };
  if (porAlias.length > 1) {
    const filtradas = filtrarPorTipo(porAlias, normal);
    if (filtradas.length === 1) return { tipo: 'cuenta', cuentaId: filtradas[0]!.id, fuente: 'alias' };
    return { tipo: 'ambigua', candidatas: filtradas.map((c) => c.id) };
  }

  // 3. Entidad → sus cuentas, filtradas por crédito/débito.
  const entidades = snap.entidades.filter((e) => [e.nombre, ...e.alias].some((a) => mencionaA(normal, a)));
  if (entidades.length > 0) {
    const ids = new Set(entidades.map((e) => e.id));
    const candidatas = filtrarPorTipo(
      activas.filter((c) => c.entidadId !== null && ids.has(c.entidadId)),
      normal,
    );
    if (candidatas.length === 1) return { tipo: 'cuenta', cuentaId: candidatas[0]!.id, fuente: 'alias' };
    if (candidatas.length > 1) return { tipo: 'ambigua', candidatas: candidatas.map((c) => c.id) };
  }

  return { tipo: 'ninguna' };
}
