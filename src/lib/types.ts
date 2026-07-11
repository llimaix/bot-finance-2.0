export const TXN_TYPES = ['gasto', 'ingreso', 'retiro', 'deposito', 'transferencia'] as const;
export type TxnType = (typeof TXN_TYPES)[number];

/**
 * Categorías SEMILLA: pueblan la base de conocimientos (items CAT# en DynamoDB)
 * la primera vez. Después el catálogo es dinámico: el LLM crea categorías
 * nuevas cuando ninguna existente encaja.
 */
export const SEED_CATEGORIES = [
  'comida',
  'supermercado',
  'transporte',
  'hogar',
  'herramientas',
  'construccion',
  'salud',
  'educacion',
  'entretenimiento',
  'ropa',
  'regalos',
  'servicios',
  'suscripciones',
  'ahorro',
  'inversion',
  'deuda',
  'otros',
] as const;

/** Abierta: cualquier slug del catálogo dinámico. */
export type Category = string;

/** Item CAT#<name> de la base de conocimientos. */
export interface CategoryRecord {
  name: string;
  emoji: string;
  source: 'seed' | 'auto';
  createdAt: string;
}

export const METHODS = ['credito', 'debito', 'efectivo', 'transferencia', 'na'] as const;
export type Method = (typeof METHODS)[number];

/** Lo que devuelve el LLM por cada movimiento. */
export interface ParsedTransaction {
  amount: number;
  type: TxnType;
  category: Category;
  method: Method;
  description: string;
}

/** Movimiento persistido en DynamoDB. */
export interface Transaction extends ParsedTransaction {
  /** SK completo: TXN#<yyyy-mm-dd>#<ulid> */
  sk: string;
  /** Emoji de la categoría, denormalizado al guardar (los items viejos no lo tienen). */
  emoji?: string;
  /** yyyy-mm-dd (hora de Guatemala) */
  date: string;
  /** Número corto del día, para /borrar y "corrige #N" */
  shortId: number;
  /** Texto original completo o transcripción */
  rawMessage: string;
  createdAt: string;
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  clarification: string | null;
  /** true solo cuando el mensaje dice explícitamente que no hubo movimientos
   *  ("hoy nada", "sin gastos"); false para saludos o mensajes ajenos al dinero. */
  noMovements: boolean;
}

// ── Cuentas (modelo de saldos) ─────────────────────────────────────────────

export const ACCOUNT_IDS = ['banco', 'tarjeta', 'efectivo', 'kash'] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

/**
 * Item ACC#<id>: posición de una cuenta. El saldo NO se muta con cada
 * movimiento: se guarda una semilla con fecha de corte (asOf) y el saldo
 * actual se calcula en lectura como semilla + deltas de los movimientos
 * con fecha POSTERIOR a asOf — sin drift, autocorregible.
 */
export interface Account {
  id: AccountId;
  name: string;
  emoji: string;
  /** Saldo al cierre de asOf. Para la tarjeta, la deuda va en negativo. */
  seedBalance: number;
  /** yyyy-mm-dd del corte de la semilla. */
  asOf: string;
  /** true cuando la semilla es un estimado (efectivo/kash sin dato real). */
  estimated: boolean;
  updatedAt: string;
}

export type ScheduleKind = 'primary' | 'followup' | 'monthly' | 'weekly';

export interface ScheduleEvent {
  kind: ScheduleKind;
}
