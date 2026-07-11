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
import type { Account, CategoryRecord, ParsedTransaction, Transaction } from './types';

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
