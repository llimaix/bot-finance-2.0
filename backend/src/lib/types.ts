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

// banrural: la cuenta secundaria. Antes no tenía método propio y "depósito a
// Banrural" se volvía debito → caía en BI (incidente 1-oct: bono de Q1,500
// sumado a BI, Banrural congelada en Q40).
export const METHODS = ['credito', 'debito', 'banrural', 'efectivo', 'transferencia', 'na'] as const;
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
  /**
   * Modelo de cuentas v2 (partida doble en centavos). Presente solo en los
   * movimientos registrados con ACCOUNTS_MODEL=v2; los campos v1 de arriba se
   * derivan de estos (v2/legacy.ts) para que reportes y agregados sigan igual.
   */
  v2?: TransactionV2;
}

export interface TransactionV2 {
  montoCentavos: number;
  tipo: 'gasto' | 'ingreso' | 'transferencia';
  origen: string | null;
  destino: string | null;
  cuentaFuente: 'terminacion' | 'alias' | 'modelo' | 'usuario';
}

export interface ParseResult {
  transactions: ParsedTransaction[];
  clarification: string | null;
  /** true solo cuando el mensaje dice explícitamente que no hubo movimientos
   *  ("hoy nada", "sin gastos"); false para saludos o mensajes ajenos al dinero. */
  noMovements: boolean;
}

// ── Cuentas (modelo de saldos) ─────────────────────────────────────────────

export const ACCOUNT_IDS = ['banco', 'banrural', 'tarjeta', 'efectivo', 'kash'] as const;
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

// ── Gastos recurrentes aprendidos (items REC#<slug>) ───────────────────────

export type RecurringStatus = 'candidate' | 'confirmed' | 'rejected';

/**
 * Conocimiento persistente sobre un gasto recurrente. Nace como `candidate`
 * cuando la heurística lo detecta (y el bot pregunta); el usuario lo vuelve
 * `confirmed` o `rejected` con los botones. Los rechazados no se vuelven a
 * preguntar; los confirmados alimentan al asesor con su día típico de pago.
 */
export interface RecurringRecord {
  slug: string;
  descripcion: string;
  categoria: string;
  /** gasto (compromiso que sale) o ingreso (salario/quincena que entra). */
  tipo: 'gasto' | 'ingreso';
  montoTipico: number;
  /** Día del mes en que suele caer (mediana). */
  diaTipico: number;
  status: RecurringStatus;
  source: 'auto' | 'user';
  /** yyyy-mm hasta el cual Allan confirmó el pago SIN registrar transacción
   *  (cargos automáticos ya horneados en los saldos): el guardián no molesta
   *  ese mes. Ausente = solo cuenta como pagado si hay transacción. */
  paidThroughMonth?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Metas de gasto por categoría (items BUD#<categoria>) ───────────────────

/**
 * Presupuesto "suave" mensual de una categoría: no bloquea nada, es la meta
 * contra la que el coach y el guardián miden el gasto del mes.
 */
export interface BudgetRecord {
  category: string;
  /** Tope mensual en quetzales. */
  monthlyLimit: number;
  /** auto = sugerida por el bot y confirmada con botón; user = fijada a mano. */
  source: 'auto' | 'user';
  createdAt: string;
  updatedAt: string;
}

// ── Memoria de hechos (items FACT#<id>) ────────────────────────────────────

/** Hecho durable que Allan le enseñó al agente ("mi salario cae el 15 y 29"). */
export interface Fact {
  id: string;
  text: string;
  createdAt: string;
}

/** Perfil del usuario (item CFG#perfil): se cambia en caliente, sin redesplegar. */
export interface Profile {
  /** Nombre con el que el bot se dirige al usuario. */
  nombre: string;
  actualizadoEn: string;
}

// ── Memoria conversacional corta ───────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export type ScheduleKind = 'primary' | 'followup' | 'monthly' | 'weekly' | 'guardian' | 'payday';

export interface ScheduleEvent {
  kind: ScheduleKind;
}
