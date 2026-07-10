export const TXN_TYPES = ['gasto', 'ingreso', 'retiro', 'deposito', 'transferencia'] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const CATEGORIES = [
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
export type Category = (typeof CATEGORIES)[number];

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
}

export type ScheduleKind = 'primary' | 'followup' | 'monthly';

export interface ScheduleEvent {
  kind: ScheduleKind;
}
