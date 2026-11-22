import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_ACCOUNTS } from './accounts';
import { SEED_CATEGORY_EMOJI } from './categories';
import { config } from './config';
import { logger } from './logger';
import { SEED_CATEGORIES } from './types';
import type {
  Account,
  BudgetRecord,
  CategoryRecord,
  ConversationMessage,
  Fact,
  ParsedTransaction,
  Profile,
  RecurringRecord,
  Transaction,
} from './types';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const PK = 'USER#allan';
const DEDUPE_TTL_SECONDS = 48 * 3600;

// ── Idempotencia de updates de Telegram ────────────────────────────────────

/** true si es la primera vez que vemos este update_id; false si es un reintento. */
export async function tryClaimUpdate(updateId: number): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: config.tableName,
        Item: {
          PK,
          SK: `UPDATE#${updateId}`,
          ttl: Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

// ── Estado del día (recordatorio + shortIds) ───────────────────────────────

/**
 * Marca el día como reportado y reserva `count` shortIds de forma atómica
 * (un solo UpdateItem: sin carrera read-then-write). Devuelve los ids reservados.
 */
export async function markReportedAndReserveShortIds(date: string, count: number): Promise<number[]> {
  const res = await doc.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { PK, SK: `DAY#${date}` },
      UpdateExpression: 'SET reported = :t ADD lastShortId :n',
      ExpressionAttributeValues: { ':t': true, ':n': count },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const last = Number(res.Attributes?.lastShortId ?? count);
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

export async function markReported(date: string): Promise<void> {
  await markReportedAndReserveShortIds(date, 0);
}

export async function getDayState(date: string): Promise<{ reported: boolean }> {
  const res = await doc.send(
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: `DAY#${date}` } }),
  );
  return { reported: res.Item?.reported === true };
}

// ── Base de conocimientos de categorías (items CAT#<nombre>) ──────────────

export async function listCategories(): Promise<CategoryRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'CAT#' },
    }),
  );
  return (res.Items ?? []).map((it) => ({
    name: it.name as string,
    emoji: it.emoji as string,
    source: it.source as CategoryRecord['source'],
    createdAt: it.createdAt as string,
  }));
}

/** Alta idempotente: si la categoría ya existe, no la toca. */
export async function putCategoryIfAbsent(cat: CategoryRecord): Promise<void> {
  try {
    await doc.send(
      new PutCommand({
        TableName: config.tableName,
        Item: { PK, SK: `CAT#${cat.name}`, ...cat },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
    logger.info('categoría creada', { category: cat.name, emoji: cat.emoji, source: cat.source });
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return;
    throw err;
  }
}

/** Catálogo vigente; la primera vez siembra las categorías base. */
export async function getOrSeedCategories(): Promise<CategoryRecord[]> {
  const existing = await listCategories();
  if (existing.length > 0) return existing;

  const createdAt = new Date().toISOString();
  const seeds: CategoryRecord[] = SEED_CATEGORIES.map((name) => ({
    name,
    emoji: SEED_CATEGORY_EMOJI[name] ?? '🏷️',
    source: 'seed',
    createdAt,
  }));
  for (const seed of seeds) await putCategoryIfAbsent(seed);
  logger.info('base de conocimientos sembrada', { count: seeds.length });
  return seeds;
}

// ── Memoria de hechos (items FACT#<id>) ────────────────────────────────────

const FACTS_LIMIT = 50;

export async function listFacts(): Promise<Fact[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'FACT#' },
      // Consistente: putFact cuenta justo después de escribir.
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? [])
    .map((it) => ({ id: it.id as string, text: it.text as string, createdAt: it.createdAt as string }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function putFact(fact: Fact): Promise<void> {
  const limitError = () => new Error(`Límite de ${FACTS_LIMIT} hechos alcanzado; borra alguno con /memoria`);
  const existing = await listFacts();
  if (existing.length >= FACTS_LIMIT) throw limitError();

  await doc.send(
    new PutCommand({ TableName: config.tableName, Item: { PK, SK: `FACT#${fact.id}`, ...fact } }),
  );

  // Otra escritura simultánea pudo pasar la misma comprobación: se vuelve a
  // contar y, si se superó el límite, se deshace la propia. En el peor caso
  // fallan las dos, nunca se queda por encima del límite.
  const after = await listFacts();
  if (after.length > FACTS_LIMIT) {
    await deleteFact(fact.id);
    throw limitError();
  }
  logger.info('hecho aprendido', { id: fact.id, text: fact.text });
}

export async function deleteFact(id: string): Promise<void> {
  await doc.send(
    new DeleteCommand({ TableName: config.tableName, Key: { PK, SK: `FACT#${id}` } }),
  );
}

// ── Perfil del usuario (item CFG#perfil) ───────────────────────────────────

export async function getProfile(): Promise<Profile | null> {
  const res = await doc.send(
    // Consistente: un cambio de nombre debe verse en el siguiente mensaje.
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: 'CFG#perfil' }, ConsistentRead: true }),
  );
  if (!res.Item?.nombre) return null;
  return { nombre: res.Item.nombre as string, actualizadoEn: res.Item.actualizadoEn as string };
}

export async function putProfile(profile: Profile): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: config.tableName, Item: { PK, SK: 'CFG#perfil', ...profile } }),
  );
  logger.info('perfil actualizado', { longitudNombre: profile.nombre.length });
}

// ── Memoria conversacional corta (item CONV#main) ──────────────────────────

const CONVERSATION_LIMIT = 12;
const CONVERSATION_TTL_SECONDS = 72 * 3600;

export async function getConversation(): Promise<ConversationMessage[]> {
  const res = await doc.send(
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: 'CONV#main' } }),
  );
  return (res.Item?.messages as ConversationMessage[] | undefined) ?? [];
}

const CONVERSATION_MAX_ATTEMPTS = 3;

/**
 * Agrega mensajes al historial, recortado a los últimos N (TTL 72h).
 *
 * Concurrencia optimista: dos mensajes casi simultáneos corren en invocaciones
 * distintas del processor; sin control, el segundo Put borraba el intercambio
 * del primero. Se escribe solo si `version` no cambió desde la lectura; si
 * cambió, se vuelve a leer y a intentar. (list_append no basta: hay que
 * recortar a los últimos N y DynamoDB no puede añadir y recortar a la vez.)
 */
export async function appendConversation(newMessages: ConversationMessage[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await doc.send(
      new GetCommand({ TableName: config.tableName, Key: { PK, SK: 'CONV#main' }, ConsistentRead: true }),
    );
    const current = (res.Item?.messages as ConversationMessage[] | undefined) ?? [];
    const version = (res.Item?.version as number | undefined) ?? 0;
    const messages = [...current, ...newMessages].slice(-CONVERSATION_LIMIT);

    try {
      await doc.send(
        new PutCommand({
          TableName: config.tableName,
          Item: {
            PK,
            SK: 'CONV#main',
            messages,
            version: version + 1,
            ttl: Math.floor(Date.now() / 1000) + CONVERSATION_TTL_SECONDS,
          },
          // Sin versión: el item no existe o es anterior a este control.
          ...(version === 0
            ? { ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(version)' }
            : { ConditionExpression: 'version = :v', ExpressionAttributeValues: { ':v': version } }),
        }),
      );
      return;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException) || attempt >= CONVERSATION_MAX_ATTEMPTS) throw err;
    }
  }
}

// ── Cooldown de preguntas de recurrentes (item META#recask) ────────────────

export async function getLastRecurringAskAt(): Promise<string | null> {
  const res = await doc.send(
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: 'META#recask' } }),
  );
  return (res.Item?.lastAt as string | undefined) ?? null;
}

export async function setLastRecurringAskAt(iso: string): Promise<void> {
  await doc.send(
    new PutCommand({ TableName: config.tableName, Item: { PK, SK: 'META#recask', lastAt: iso } }),
  );
}

// ── Recurrentes aprendidos (items REC#<slug>) ──────────────────────────────

export async function listRecurring(): Promise<RecurringRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'REC#' },
    }),
  );
  return (res.Items ?? []).map((it) => ({
    slug: it.slug as string,
    descripcion: it.descripcion as string,
    categoria: it.categoria as string,
    // items previos a la detección de ingresos no traen tipo
    tipo: (it.tipo as RecurringRecord['tipo'] | undefined) ?? 'gasto',
    montoTipico: it.montoTipico as number,
    diaTipico: it.diaTipico as number,
    status: it.status as RecurringRecord['status'],
    source: it.source as RecurringRecord['source'],
    ...(it.paidThroughMonth ? { paidThroughMonth: it.paidThroughMonth as string } : {}),
    createdAt: it.createdAt as string,
    updatedAt: it.updatedAt as string,
  }));
}

export async function putRecurring(record: RecurringRecord): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: config.tableName,
      Item: { PK, SK: `REC#${record.slug}`, ...record },
    }),
  );
  logger.info('recurrente actualizado', { slug: record.slug, status: record.status });
}

// ── Contabilidad de tokens de IA (item USAGE#<yyyy-mm>) ────────────────────

/** Suma atómica del consumo de una llamada LLM al mes en curso. */
export async function addUsage(
  month: string,
  fn: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { PK, SK: `USAGE#${month}` },
      UpdateExpression:
        'ADD inTokens :i, outTokens :o, calls :one, #mi :i, #mo :o, #fi :i, #fo :o',
      ExpressionAttributeNames: {
        '#mi': `m_in::${model}`,
        '#mo': `m_out::${model}`,
        '#fi': `f_in::${fn}`,
        '#fo': `f_out::${fn}`,
      },
      ExpressionAttributeValues: { ':i': inputTokens, ':o': outputTokens, ':one': 1 },
    }),
  );
}

export async function getUsage(month: string): Promise<Record<string, unknown> | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: `USAGE#${month}` } }),
  );
  return res.Item;
}

// ── Metas de gasto por categoría (items BUD#<categoria>) ──────────────────

export async function listBudgets(): Promise<BudgetRecord[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'BUD#' },
    }),
  );
  return (res.Items ?? []).map((it) => ({
    category: it.category as string,
    monthlyLimit: it.monthlyLimit as number,
    source: it.source as BudgetRecord['source'],
    createdAt: it.createdAt as string,
    updatedAt: it.updatedAt as string,
  }));
}

export async function putBudget(budget: BudgetRecord): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: config.tableName,
      Item: { PK, SK: `BUD#${budget.category}`, ...budget },
    }),
  );
  logger.info('meta actualizada', { category: budget.category, monthlyLimit: budget.monthlyLimit });
}

export async function deleteBudget(category: string): Promise<void> {
  await doc.send(
    new DeleteCommand({ TableName: config.tableName, Key: { PK, SK: `BUD#${category}` } }),
  );
  logger.info('meta eliminada', { category });
}

// ── Cuentas (modelo de saldos, items ACC#<id>) ─────────────────────────────

export async function listAccounts(): Promise<Account[]> {
  const res = await doc.send(
    new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'ACC#' },
    }),
  );
  return (res.Items ?? []).map((it) => ({
    id: it.id as Account['id'],
    name: it.name as string,
    emoji: it.emoji as string,
    seedBalance: it.seedBalance as number,
    asOf: it.asOf as string,
    estimated: it.estimated === true,
    updatedAt: it.updatedAt as string,
  }));
}

export async function putAccount(account: Account): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: config.tableName,
      Item: { PK, SK: `ACC#${account.id}`, ...account },
    }),
  );
  logger.info('cuenta actualizada', { id: account.id, seedBalance: account.seedBalance, asOf: account.asOf });
}

/** Cuentas actuales; la primera vez las crea en cero (estimadas) con asOf de hoy. */
export async function getOrSeedAccounts(today: string): Promise<Account[]> {
  const existing = await listAccounts();
  if (existing.length > 0) return existing;

  const updatedAt = new Date().toISOString();
  const seeds: Account[] = DEFAULT_ACCOUNTS.map((acc) => ({
    ...acc,
    seedBalance: 0,
    asOf: today,
    estimated: true,
    updatedAt,
  }));
  for (const seed of seeds) await putAccount(seed);
  return seeds;
}

// ── Transacciones ──────────────────────────────────────────────────────────

interface TxnItem extends ParsedTransaction {
  PK: string;
  SK: string;
  date: string;
  shortId: number;
  rawMessage: string;
  createdAt: string;
  emoji?: string;
}

function toTransaction(item: Record<string, unknown>): Transaction {
  const it = item as unknown as TxnItem;
  return {
    sk: it.SK,
    date: it.date,
    shortId: it.shortId,
    amount: it.amount,
    type: it.type,
    category: it.category,
    method: it.method,
    description: it.description,
    rawMessage: it.rawMessage,
    createdAt: it.createdAt,
    ...(it.emoji ? { emoji: it.emoji } : {}),
  };
}

export async function putTransactions(txns: Transaction[]): Promise<void> {
  // Son pocas por mensaje (≤ ~5): puts secuenciales, sin batch.
  for (const txn of txns) {
    const { sk, ...rest } = txn;
    await doc.send(
      new PutCommand({
        TableName: config.tableName,
        Item: { PK, SK: sk, ...rest },
      }),
    );
  }
}

async function queryByPrefix(skPrefix: string): Promise<Transaction[]> {
  const items: Transaction[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': PK, ':prefix': skPrefix },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(res.Items ?? []).map(toTransaction));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export const queryDay = (date: string): Promise<Transaction[]> => queryByPrefix(`TXN#${date}`);

export const queryMonth = (yyyyMM: string): Promise<Transaction[]> => queryByPrefix(`TXN#${yyyyMM}`);

/** Rango inclusivo de fechas yyyy-mm-dd (para /semana). */
export async function queryRange(fromDate: string, toDate: string): Promise<Transaction[]> {
  const items: Transaction[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': PK,
          ':from': `TXN#${fromDate}`,
          // sufijo alto para que el BETWEEN incluya todos los ulid del día final
          ':to': `TXN#${toDate}` + '￿',
        },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(res.Items ?? []).map(toTransaction));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function getTransaction(sk: string): Promise<Transaction | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: config.tableName, Key: { PK, SK: sk } }),
  );
  return res.Item ? toTransaction(res.Item) : undefined;
}

export async function findByShortId(date: string, shortId: number): Promise<Transaction | undefined> {
  const txns = await queryDay(date);
  return txns.find((t) => t.shortId === shortId);
}

export async function deleteTransaction(sk: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: config.tableName, Key: { PK, SK: sk } }));
}

/** Actualiza solo los campos regenerados por una corrección; conserva SK/shortId/rawMessage/createdAt. */
export async function updateTransactionFields(
  sk: string,
  fields: ParsedTransaction & { emoji: string },
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: config.tableName,
      Key: { PK, SK: sk },
      UpdateExpression:
        'SET amount = :amount, #type = :type, category = :category, #method = :method, description = :description, emoji = :emoji',
      ExpressionAttributeNames: { '#type': 'type', '#method': 'method' },
      ExpressionAttributeValues: {
        ':amount': fields.amount,
        ':type': fields.type,
        ':category': fields.category,
        ':method': fields.method,
        ':description': fields.description,
        ':emoji': fields.emoji,
      },
    }),
  );
}
