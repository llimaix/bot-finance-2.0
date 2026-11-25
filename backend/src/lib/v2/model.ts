/**
 * Modelo de cuentas v2 (docs/diseno-cuentas-dinamicas.md, secciones 2, 3 y 3.2).
 *
 * Partida doble simplificada: cada movimiento dice de dónde SALE (origen) y a
 * dónde ENTRA (destino) el dinero; null = mundo exterior. Las invariantes se
 * validan aquí, en código, nunca se confían al modelo de lenguaje.
 *
 * Se construye en paralelo al modelo v1 (method + type) y no se usa hasta la
 * activación de la fase 4 del plan.
 */
import { z } from 'zod';
import { normalizeAlias } from './aliases';
import { isValidAmountCents } from './money';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug en minúsculas con guiones');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha yyyy-mm-dd');
const dayOfMonth = z.number().int().min(1).max(31);
export const ACCOUNT_KINDS = ['banco', 'credito', 'efectivo', 'billetera', 'prestamo'] as const;
export const TXN_KINDS = ['gasto', 'ingreso', 'transferencia'] as const;
export const ACCOUNT_SOURCES = ['terminacion', 'alias', 'modelo', 'usuario'] as const;

export const entidadSchema = z.object({
  id: slug,
  nombre: z.string().min(1).max(60),
  alias: z.array(z.string().min(1).max(40)),
});
export type EntidadBancaria = z.infer<typeof entidadSchema>;

export const interesSchema = z.object({
  tasaBps: z.number().int().positive(),
  periodo: z.enum(['mensual', 'anual']),
});

export const creditoSchema = z.object({
  limiteCentavos: z.number().int().positive(),
  diaCorte: dayOfMonth,
  diaPago: dayOfMonth,
  ajustePago: z.enum(['siguiente_habil', 'anterior_habil', 'ninguno']),
  diasAviso: z.array(z.number().int().min(0).max(31)),
  interes: interesSchema.optional(),
});

/** Datos de un préstamo: todos opcionales, el saldo (deuda) vive en la semilla. */
export const prestamoSchema = z.object({
  cuotaCentavos: z.number().int().positive().optional(),
  diaPago: dayOfMonth.optional(),
  interes: interesSchema.optional(),
  plazoCuotas: z.number().int().positive().optional(),
  vence: isoDate.optional(),
});

export const cuentaSchema = z.object({
  id: slug,
  nombre: z.string().min(1).max(60),
  tipo: z.enum(ACCOUNT_KINDS),
  entidadId: slug.nullable(),
  terminaciones: z.array(z.string().regex(/^\d{4}$/, 'terminación de 4 dígitos')),
  alias: z.array(z.string().min(1).max(40)),
  semillaCentavos: z.number().int(),
  asOf: isoDate,
  estimada: z.boolean(),
  activa: z.boolean(),
  credito: creditoSchema.optional(),
  prestamo: prestamoSchema.optional(),
});
export type Cuenta = z.infer<typeof cuentaSchema>;

/**
 * Única regla para clasificar cuentas. Antes se repetía `tipo !== 'credito'`
 * en cada cálculo, y cualquier tipo nuevo (un préstamo) se colaba como efectivo.
 */
export const esLiquida = (c: Pick<Cuenta, 'tipo'>): boolean =>
  c.tipo === 'banco' || c.tipo === 'efectivo' || c.tipo === 'billetera';
/** Deuda de corto plazo: tarjetas de crédito. */
export const esTarjeta = (c: Pick<Cuenta, 'tipo'>): boolean => c.tipo === 'credito';
export const esPrestamo = (c: Pick<Cuenta, 'tipo'>): boolean => c.tipo === 'prestamo';
/** El saldo se guarda como deuda en negativo. */
/**
 * Un alias nunca lleva un número de cuenta, tarjeta o préstamo (6+ dígitos
 * seguidos, ignorando espacios y guiones): las terminaciones de 4 dígitos van
 * en su propio campo. Se valida solo al AGREGAR alias, no en el esquema, para
 * que una cuenta ya guardada con uno así siga cargando y se pueda corregir.
 */
export function aliasConNumero(alias: string): boolean {
  return /\d{6,}/.test(alias.replace(/[\s-]/g, ''));
}

export const esDeuda = (c: Pick<Cuenta, 'tipo'>): boolean => esTarjeta(c) || esPrestamo(c);

export const movimientoSchema = z.object({
  fecha: isoDate,
  montoCentavos: z.number().int().positive(),
  tipo: z.enum(TXN_KINDS),
  origen: slug.nullable(),
  destino: slug.nullable(),
  categoria: z.string().min(1),
  descripcion: z.string(),
  cuentaFuente: z.enum(ACCOUNT_SOURCES),
});
export type Movimiento = z.infer<typeof movimientoSchema>;

// ── Invariantes ────────────────────────────────────────────────────────────

export interface Validation {
  /** Impiden guardar. */
  errors: string[];
  /** Se guardan, pero se avisa al usuario (casi seguro es un error). */
  warnings: string[];
}

/** Invariantes de un movimiento contra las cuentas existentes (sección 3.1). */
export function validateMovimiento(m: Movimiento, cuentas: ReadonlyArray<Cuenta>): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(cuentas.map((c) => [c.id, c]));

  if (!isValidAmountCents(m.montoCentavos)) errors.push('El monto debe ser un entero de centavos mayor que 0.');
  if (m.origen === null && m.destino === null) errors.push('El movimiento necesita origen o destino.');
  if (m.origen !== null && m.origen === m.destino) errors.push('El origen y el destino no pueden ser la misma cuenta.');
  if (m.tipo === 'gasto' && m.origen === null) errors.push('Un gasto necesita la cuenta de origen.');
  if (m.tipo === 'ingreso' && m.destino === null) errors.push('Un ingreso necesita la cuenta de destino.');
  if (m.tipo === 'transferencia' && (m.origen === null || m.destino === null)) {
    errors.push('Una transferencia necesita origen y destino.');
  }

  for (const [rol, id] of [['origen', m.origen], ['destino', m.destino]] as const) {
    if (id === null) continue;
    const cuenta = byId.get(id);
    if (!cuenta) errors.push(`La cuenta de ${rol} "${id}" no existe.`);
    else if (!cuenta.activa) errors.push(`La cuenta de ${rol} "${cuenta.nombre}" está cerrada.`);
  }

  if (m.tipo === 'ingreso' && m.destino !== null && byId.get(m.destino)?.tipo === 'credito') {
    warnings.push('Un ingreso hacia una tarjeta de crédito es raro: ¿no será un pago de tarjeta (transferencia)?');
  }
  if (m.tipo === 'ingreso' && m.destino !== null && byId.get(m.destino)?.tipo === 'prestamo') {
    warnings.push('Un ingreso hacia un préstamo es raro: ¿no será el pago de la cuota (transferencia)?');
  }
  if (m.tipo === 'gasto' && m.origen !== null && byId.get(m.origen)?.tipo === 'prestamo') {
    warnings.push('Un gasto pagado desde un préstamo es raro: ¿no salió de tu cuenta de banco?');
  }
  return { errors, warnings };
}

/**
 * Invariantes del conjunto de cuentas y entidades: terminaciones y alias
 * únicos, tasa solo en crédito, entidades existentes (secciones 3.1 y 3.2).
 */
export function validateConfig(cuentas: ReadonlyArray<Cuenta>, entidades: ReadonlyArray<EntidadBancaria>): Validation {
  const errors: string[] = [];
  const entidadIds = new Set(entidades.map((e) => e.id));

  const terminaciones = new Map<string, string>();
  for (const c of cuentas) {
    for (const t of c.terminaciones) {
      const otra = terminaciones.get(t);
      if (otra && otra !== c.id) errors.push(`La terminación ${t} está en "${otra}" y en "${c.id}".`);
      terminaciones.set(t, c.id);
    }
    if (c.entidadId !== null && !entidadIds.has(c.entidadId)) {
      errors.push(`La cuenta "${c.id}" apunta a la entidad "${c.entidadId}", que no existe.`);
    }
    if (c.tipo !== 'credito' && c.credito) errors.push(`Solo las tarjetas de crédito tienen datos de crédito ("${c.id}").`);
    if (c.tipo === 'credito' && !c.credito) errors.push(`La tarjeta "${c.id}" necesita corte, pago y límite.`);
    if (c.tipo !== 'prestamo' && c.prestamo) errors.push(`Solo los préstamos tienen datos de préstamo ("${c.id}").`);
  }

  // Un alias normalizado pertenece a una sola entidad o cuenta.
  const owners = new Map<string, string>();
  const claim = (alias: string, owner: string) => {
    const key = normalizeAlias(alias);
    const previo = owners.get(key);
    if (previo && previo !== owner) errors.push(`El alias "${alias}" está en ${previo} y en ${owner}.`);
    owners.set(key, owner);
  };
  for (const e of entidades) for (const a of e.alias) claim(a, `la entidad "${e.id}"`);
  for (const c of cuentas) for (const a of c.alias) claim(a, `la cuenta "${c.id}"`);

  return { errors, warnings: [] };
}
