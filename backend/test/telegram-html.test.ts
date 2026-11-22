import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { code, escapeHtml } from '../src/lib/format';

/**
 * Guard estático contra el incidente 29/30-jul: `/saldo ${id} <monto>` viajó
 * como parse_mode HTML, Telegram lo leyó como tag de apertura desconocido y
 * respondió 400 — el guardián diario no llegó durante dos días. El bug es
 * invisible en revisión: se lee como texto normal.
 */

/** Los únicos tags que Telegram entiende en parse_mode: "HTML". */
const TELEGRAM_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote',
]);

// Los prompts del LLM usan <placeholders> a propósito y NO van a Telegram.
const EXCLUDED = ['src/lib/ai'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Los comentarios describen formatos de clave ("items ACC#<id>"), no se envían. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const LITERAL = String.raw`\`(?:[^\`\\]|\\.)*\`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`;
const STRING_LITERAL = new RegExp(LITERAL, 'g');
const TAG = /<\/?([a-zA-ZáéíóúñÁÉÍÓÚÑ][\wáéíóúñÁÉÍÓÚÑ-]*)/g;

/**
 * Un placeholder DENTRO de code()/escapeHtml() ya sale escapado — es la forma
 * correcta y no debe marcarse. Lo que el guard persigue es el ángulo suelto,
 * el que viaja crudo a parse_mode HTML.
 */
const ESCAPED_CALL = new RegExp(String.raw`\b(?:code|escapeHtml)\(\s*(?:${LITERAL})\s*\)`, 'g');

/** Tags que Telegram rechazaría, con el literal donde viven (para el reporte). */
function illegalTags(src: string): { tag: string; literal: string }[] {
  const found: { tag: string; literal: string }[] = [];
  for (const literal of src.replace(ESCAPED_CALL, 'SEGURO').matchAll(STRING_LITERAL)) {
    for (const [, tag] of literal[0].matchAll(TAG)) {
      if (tag && !TELEGRAM_TAGS.has(tag.toLowerCase())) found.push({ tag, literal: literal[0].trim() });
    }
  }
  return found;
}

describe('HTML de Telegram en strings del código', () => {
  const files = sourceFiles('src')
    .map((f) => f.replaceAll('\\', '/'))
    .filter((f) => !EXCLUDED.some((skip) => f.startsWith(skip)));

  it('encuentra archivos que escanear (el guard no se auto-desactiva)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s no emite tags que Telegram rechace', (file) => {
    const offenders = illegalTags(stripComments(readFileSync(file, 'utf8')));
    expect(offenders.map((o) => `<${o.tag}> en ${o.literal}`)).toEqual([]);
  });

  it('el guard SÍ detecta el bug original (no pasa por vacuidad)', () => {
    const bug = 'sendMessage(chatId, `Ajusta con /saldo ${id} <monto>.`)';
    expect(illegalTags(bug).map((o) => o.tag)).toEqual(['monto']);
  });

  it('la forma corregida pasa limpia', () => {
    expect(illegalTags('code(`/saldo ${id} <monto>`)')).toEqual([]);
  });
});

describe('code(): el placeholder se escribe natural y sale escapado', () => {
  it('escapa los ángulos que romperían el parseo', () => {
    expect(code('/saldo efectivo <monto>')).toBe('<code>/saldo efectivo &lt;monto&gt;</code>');
  });

  it('escapa & antes que los ángulos (no genera entidades falsas)', () => {
    expect(code('a & <b>')).toBe('<code>a &amp; &lt;b&gt;</code>');
  });

  it('escapeHtml sigue siendo idempotente en lo que ya es seguro', () => {
    expect(escapeHtml('/saldo efectivo 350')).toBe('/saldo efectivo 350');
  });
});
