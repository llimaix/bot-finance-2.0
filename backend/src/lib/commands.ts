import botCommands from './bot-commands.json';
import { ACCOUNT_IDS } from './types';
import type { AccountId, Method } from './types';

export type Command =
  | { kind: 'hoy' }
  | { kind: 'semana' }
  | { kind: 'mes' }
  | { kind: 'reporte' }
  | { kind: 'nada' }
  | { kind: 'categorias' }
  | { kind: 'recurrentes' }
  | { kind: 'memoria' }
  | { kind: 'proyeccion' }
  | { kind: 'export' }
  | { kind: 'saldo'; set: { account: AccountId; amount: number } | null; invalidArgs: boolean }
  | { kind: 'metas'; action: MetasAction; invalidArgs: boolean }
  | { kind: 'costo' }
  | { kind: 'borrar'; shortId: number | null }
  | { kind: 'nombre'; name: string | null }
  | { kind: 'ayuda' };

export type MetasAction =
  | { op: 'ver' }
  | { op: 'sugerir' }
  | { op: 'fijar'; category: string; amount: number }
  | { op: 'quitar'; category: string };

const COMMAND_RE =
  /^\/(hoy|semana|mes|reporte|nada|categorias|recurrentes|memoria|proyeccion|export|saldo|metas|costo|borrar|nombre|start|help|ayuda)(?:@\w+)?(?:\s+(.*))?$/is;

/** Detecta comandos /hoy /semana /mes /reporte /borrar N (tolera @NombreDelBot). */
export function matchCommand(text: string): Command | null {
  const m = text.trim().match(COMMAND_RE);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const arg = m[2]?.trim();
  switch (name) {
    case 'hoy':
      return { kind: 'hoy' };
    case 'semana':
      return { kind: 'semana' };
    case 'mes':
      return { kind: 'mes' };
    case 'reporte':
      return { kind: 'reporte' };
    case 'nada':
      return { kind: 'nada' };
    case 'categorias':
      return { kind: 'categorias' };
    case 'recurrentes':
      return { kind: 'recurrentes' };
    case 'memoria':
      return { kind: 'memoria' };
    case 'proyeccion':
      return { kind: 'proyeccion' };
    case 'costo':
      return { kind: 'costo' };
    case 'export':
      return { kind: 'export' };
    case 'saldo': {
      if (!arg) return { kind: 'saldo', set: null, invalidArgs: false };
      const m2 = arg.match(/^(\S+)\s+(-?[\d,]+(?:\.\d+)?)$/);
      const account = m2?.[1]?.toLowerCase();
      const amount = m2 ? Number.parseFloat(m2[2]!.replaceAll(',', '')) : Number.NaN;
      if (!account || !(ACCOUNT_IDS as readonly string[]).includes(account) || !Number.isFinite(amount)) {
        return { kind: 'saldo', set: null, invalidArgs: true };
      }
      return { kind: 'saldo', set: { account: account as AccountId, amount }, invalidArgs: false };
    }
    case 'metas': {
      if (!arg) return { kind: 'metas', action: { op: 'ver' }, invalidArgs: false };
      if (/^sugerir$/i.test(arg)) return { kind: 'metas', action: { op: 'sugerir' }, invalidArgs: false };
      const quitar = arg.match(/^quitar\s+(\S+)$/i);
      if (quitar) return { kind: 'metas', action: { op: 'quitar', category: quitar[1]!.toLowerCase() }, invalidArgs: false };
      const fijar = arg.match(/^(\S+)\s+([\d,]+(?:\.\d+)?)$/);
      const amount = fijar ? Number.parseFloat(fijar[2]!.replaceAll(',', '')) : Number.NaN;
      if (fijar && Number.isFinite(amount) && amount > 0) {
        return { kind: 'metas', action: { op: 'fijar', category: fijar[1]!.toLowerCase(), amount }, invalidArgs: false };
      }
      return { kind: 'metas', action: { op: 'ver' }, invalidArgs: true };
    }

    case 'borrar': {
      const n = Number.parseInt(arg?.replace(/^#/, '') ?? '', 10);
      return { kind: 'borrar', shortId: Number.isInteger(n) && n > 0 ? n : null };
    }
    case 'nombre':
      // Sin argumento: muestra el nombre actual. La validación vive en profile.ts.
      return { kind: 'nombre', name: arg ? arg : null };
    default:
      // /start, /help, /ayuda
      return { kind: 'ayuda' };
  }
}

export interface Correction {
  shortId: number;
  text: string;
}

const CORRECTION_RE = /^corrige\s*(?:el\s+|la\s+)?#?\s*(\d+)\s*[:,.\-—]?\s*(.+)$/is;

/** Detecta "corrige #2 fue con débito" (y variantes sin #, con : o ,). */
export function matchCorrection(text: string): Correction | null {
  const m = text.trim().match(CORRECTION_RE);
  if (!m) return null;
  const shortId = Number.parseInt(m[1]!, 10);
  const correction = m[2]!.trim();
  if (!Number.isInteger(shortId) || shortId <= 0 || !correction) return null;
  return { shortId, text: correction };
}

// Respuesta a "¿de qué cuenta salió?": el mensaje es SOLO el método (con
// rellenos permitidos), no un gasto nuevo. Anclado a ^...$ con lista blanca de
// rellenos → "gasté Q50 con débito" NO matchea (tiene palabras fuera de lista).
const METHOD_ANSWER_RE =
  /^\s*(?:(?:fue|es|era|lo\s+pagu[eé]|sali[oó]|con|de|la|el|una|tarjeta|del|banco|bac|bi)\s+)*(cr[eé]dito|d[eé]bito|efectivo|banrural)(?:\s+(?:bac|bi|contado|del\s+banco|de\s+bi))?\s*[.!]*\s*$/i;

/** Detecta un mensaje que es SOLO la respuesta del método/cuenta ("Tarjeta
 *  crédito", "fue con débito", "efectivo"). Devuelve el método normalizado. */
export function matchMethodAnswer(text: string): Method | null {
  const m = text.trim().match(METHOD_ANSWER_RE);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw.startsWith('cr')) return 'credito';
  if (raw.startsWith('d')) return 'debito';
  if (raw === 'banrural') return 'banrural';
  return 'efectivo';
}

export const HELP_TEXT = [
  '🤖 <b>Bot de finanzas personales</b>',
  '',
  'Cuéntame tus movimientos del día en texto o nota de voz, por ejemplo:',
  '"almuerzo Q45 en efectivo y Q200 de gasolina con la de crédito"',
  '',
  'Comandos:',
  '/hoy — movimientos del día',
  '/semana — resumen de los últimos 7 días',
  '/mes — resumen del mes en curso',
  '/reporte — reporte completo del mes con análisis',
  '/nada — registrar día sin movimientos',
  '/categorias — tu base de conocimientos de categorías',
  '/saldo — cuánto tienes en cada cuenta (ajusta con: /saldo efectivo 350)',
  '/proyeccion — cuánto te quedará a fin de mes (ingresos y compromisos pendientes)',
  '/metas — metas de gasto por categoría (/metas sugerir, /metas comida 1500)',
  '/costo — cuánto ha costado la IA este mes (tokens y USD estimado)',
  '/recurrentes — tus gastos recurrentes aprendidos y por confirmar',
  '/memoria — los hechos que el agente ha aprendido de ti',
  '/export — el mes en curso como archivo CSV',
  '/borrar N — elimina el movimiento #N de hoy',
  '/nombre — cómo te llamo (cámbialo con: /nombre Luis)',
  '',
  'También puedes: mandar la 📸 foto de un ticket (con caption opcional), decir "ayer gasté..." para fechas pasadas, PREGUNTAR ("¿cuánto tengo?", "¿cuánto llevo en comida?") y corregir con "corrige #2 eran Q50".',
  '',
  'Las categorías se organizan solas: si un movimiento no encaja en ninguna, el bot crea una nueva automáticamente.',
].join('\n');

/**
 * Menú de comandos que se registra en Telegram (setMyCommands). Fuente única en
 * bot-commands.json: también la lee scripts/set-webhook.mjs, que corre con Node
 * sin dependencias y no puede importar TypeScript.
 */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = botCommands;
