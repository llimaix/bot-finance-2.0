export type Command =
  | { kind: 'hoy' }
  | { kind: 'semana' }
  | { kind: 'mes' }
  | { kind: 'reporte' }
  | { kind: 'nada' }
  | { kind: 'categorias' }
  | { kind: 'export' }
  | { kind: 'borrar'; shortId: number | null }
  | { kind: 'ayuda' };

const COMMAND_RE = /^\/(hoy|semana|mes|reporte|nada|categorias|export|borrar|start|help|ayuda)(?:@\w+)?(?:\s+(.*))?$/is;

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
    case 'export':
      return { kind: 'export' };
    case 'borrar': {
      const n = Number.parseInt(arg?.replace(/^#/, '') ?? '', 10);
      return { kind: 'borrar', shortId: Number.isInteger(n) && n > 0 ? n : null };
    }
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
  '/export — el mes en curso como archivo CSV',
  '/borrar N — elimina el movimiento #N de hoy',
  '',
  'También puedes: mandar la 📸 foto de un ticket (con caption opcional), decir "ayer gasté..." para fechas pasadas, y corregir con "corrige #2 eran Q50".',
  '',
  'Las categorías se organizan solas: si un movimiento no encaja en ninguna, el bot crea una nueva automáticamente.',
].join('\n');

/** Menú de comandos que se registra en Telegram (setMyCommands) en cada deploy. */
export const BOT_COMMANDS = [
  { command: 'hoy', description: 'Movimientos del día' },
  { command: 'semana', description: 'Resumen de los últimos 7 días' },
  { command: 'mes', description: 'Resumen del mes en curso' },
  { command: 'reporte', description: 'Reporte del mes con análisis' },
  { command: 'nada', description: 'Registrar día sin movimientos' },
  { command: 'categorias', description: 'Ver la base de conocimientos de categorías' },
  { command: 'export', description: 'Exportar el mes en curso como CSV' },
  { command: 'borrar', description: 'Eliminar el movimiento #N de hoy' },
  { command: 'ayuda', description: 'Cómo usar el bot' },
] as const;
