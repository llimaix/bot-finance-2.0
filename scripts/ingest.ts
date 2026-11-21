/**
 * Ingesta masiva de movimientos (puesta al día con estados de cuenta).
 *
 * Escribe directo a DynamoDB usando el mismo modelo del bot (shortIds atómicos
 * por día, emoji denormalizado, categorías en la base de conocimientos).
 * Cada item queda etiquetado con rawMessage = "ingesta:<tag>" para poder
 * deshacer el lote completo.
 *
 * Uso (con credenciales AWS del perfil personal):
 *   AWS_PROFILE=personal AWS_REGION=us-east-1 TABLE_NAME=finanzas-personales \
 *     pnpm tsx scripts/ingest.ts data/ingesta-2026-05a07.json           # dry-run
 *     pnpm tsx scripts/ingest.ts data/ingesta-2026-05a07.json --apply   # escribe
 *     pnpm tsx scripts/ingest.ts --undo estados-2026-05a07              # borra el lote
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ulid } from 'ulid';
import { slugifyCategory } from '../src/lib/categories';
import {
  deleteTransaction,
  getOrSeedCategories,
  markReportedAndReserveShortIds,
  putCategoryIfAbsent,
  putTransactions,
  queryMonth,
} from '../src/lib/dynamo';
import { formatQ } from '../src/lib/format';
import { METHODS, TXN_TYPES } from '../src/lib/types';
import type { Transaction } from '../src/lib/types';

const fileSchema = z.object({
  tag: z.string().min(1),
  newCategories: z.array(z.object({ name: z.string().min(1), emoji: z.string().min(1) })),
  transactions: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        amount: z.number().positive(),
        type: z.enum(TXN_TYPES),
        category: z.string().min(1),
        method: z.enum(METHODS),
        description: z.string().min(1),
      }),
    )
    .min(1),
});

async function undo(tag: string): Promise<void> {
  const rawTag = `ingesta:${tag}`;
  // queryMonth('') = begins_with(SK, 'TXN#') → todos los movimientos
  const all = await queryMonth('');
  const targets = all.filter((t) => t.rawMessage === rawTag);
  console.log(`Encontrados ${targets.length} movimientos del lote "${tag}". Borrando...`);
  for (const t of targets) await deleteTransaction(t.sk);
  console.log(`✅ Lote "${tag}" eliminado (${targets.length} items).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const undoIdx = args.indexOf('--undo');
  if (undoIdx !== -1) {
    const tag = args[undoIdx + 1];
    if (!tag) throw new Error('Uso: --undo <tag>');
    await undo(tag);
    return;
  }

  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Uso: pnpm tsx scripts/ingest.ts <archivo.json> [--apply]');
  const apply = args.includes('--apply');

  const data = fileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

  // Validar categorías contra la base de conocimientos + las nuevas declaradas
  const catalog = await getOrSeedCategories();
  const emojiByName = new Map(catalog.map((c) => [c.name, c.emoji]));
  for (const nc of data.newCategories) emojiByName.set(slugifyCategory(nc.name), nc.emoji);

  for (const t of data.transactions) {
    const slug = slugifyCategory(t.category);
    if (slug !== t.category) throw new Error(`Categoría no normalizada: "${t.category}" (usa "${slug}")`);
    if (!emojiByName.has(slug)) throw new Error(`Categoría desconocida y no declarada: "${t.category}"`);
  }

  // ── Resumen (dry-run y apply) ────────────────────────────────────────────
  const byMonthType = new Map<string, Map<string, { sum: number; count: number }>>();
  for (const t of data.transactions) {
    const month = t.date.slice(0, 7);
    const perType = byMonthType.get(month) ?? new Map();
    const acc = perType.get(t.type) ?? { sum: 0, count: 0 };
    acc.sum = Math.round((acc.sum + t.amount) * 100) / 100;
    acc.count += 1;
    perType.set(t.type, acc);
    byMonthType.set(month, perType);
  }

  console.log(`Lote: ${data.tag} — ${data.transactions.length} movimientos`);
  console.log(`Categorías nuevas: ${data.newCategories.map((c) => `${c.emoji} ${c.name}`).join(', ') || '(ninguna)'}`);
  for (const [month, perType] of [...byMonthType.entries()].sort()) {
    console.log(`\n📆 ${month}`);
    for (const [type, acc] of [...perType.entries()].sort()) {
      console.log(`   ${type.padEnd(14)} ${String(acc.count).padStart(3)} movs  ${formatQ(acc.sum)}`);
    }
  }

  if (!apply) {
    console.log('\n(dry-run: nada escrito — agrega --apply para ejecutar)');
    return;
  }

  // ── Escritura ────────────────────────────────────────────────────────────
  const createdAt = new Date().toISOString();
  for (const nc of data.newCategories) {
    await putCategoryIfAbsent({
      name: slugifyCategory(nc.name),
      emoji: nc.emoji,
      source: 'auto',
      createdAt,
    });
  }

  const byDate = new Map<string, typeof data.transactions>();
  for (const t of data.transactions) {
    const group = byDate.get(t.date) ?? [];
    group.push(t);
    byDate.set(t.date, group);
  }

  let written = 0;
  for (const [date, group] of [...byDate.entries()].sort()) {
    const shortIds = await markReportedAndReserveShortIds(date, group.length);
    const txns: Transaction[] = group.map((t, i) => ({
      ...t,
      sk: `TXN#${date}#${ulid()}`,
      shortId: shortIds[i]!,
      rawMessage: `ingesta:${data.tag}`,
      createdAt,
      emoji: emojiByName.get(t.category)!,
    }));
    await putTransactions(txns);
    written += txns.length;
    process.stdout.write(`\r✍️  ${written}/${data.transactions.length} escritos (${date})   `);
  }

  console.log(`\n✅ Ingesta completa: ${written} movimientos con etiqueta "ingesta:${data.tag}".`);
  console.log(`   Para deshacer: pnpm tsx scripts/ingest.ts --undo ${data.tag}`);
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
