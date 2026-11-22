/**
 * Configuración de cuentas y entidades v2: lógica PURA (sin IO).
 *
 * Convierte lo que pide el agente en entidades y cuentas válidas, las valida
 * contra lo ya configurado (validateConfig) y genera el resumen que ve el
 * usuario. El resumen sale de lo que se va a guardar, no de lo que el modelo
 * cree haber hecho: si interpretó mal, se ve en ese mismo mensaje.
 */
import { escapeHtml } from '../format';
import { normalizeAlias } from './aliases';
import { cuentaSchema, entidadSchema, validateConfig } from './model';
import type { Cuenta, EntidadBancaria } from './model';
import { formatCents, toCents } from './money';

export interface ConfigSnapshot {
  cuentas: Cuenta[];
  entidades: EntidadBancaria[];
}

export type Plan<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const unique = (xs: ReadonlyArray<string>): string[] => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export function slugify(text: string): string {
  const s = normalizeAlias(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'cuenta';
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

const zodErrors = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string[] =>
  issues.map((i) => `${i.path.map(String).join('.') || 'dato'}: ${i.message}`);

/** Entidad por id, nombre o alias (normalizados). */
export function findEntidad(ref: string, entidades: ReadonlyArray<EntidadBancaria>): EntidadBancaria | undefined {
  const key = normalizeAlias(ref);
  return entidades.find(
    (e) => e.id === key || normalizeAlias(e.nombre) === key || e.alias.some((a) => normalizeAlias(a) === key),
  );
}

/** Cuenta por id, nombre, alias o terminación de 4 dígitos. */
export function findCuenta(ref: string, cuentas: ReadonlyArray<Cuenta>): Cuenta | undefined {
  const raw = ref.trim().replace(/^[•*x]+/i, '');
  if (/^\d{4}$/.test(raw)) return cuentas.find((c) => c.terminaciones.includes(raw));
  const key = normalizeAlias(ref);
  return cuentas.find(
    (c) => c.id === key || normalizeAlias(c.nombre) === key || c.alias.some((a) => normalizeAlias(a) === key),
  );
}

// ── Entidades ──────────────────────────────────────────────────────────────

export interface EntidadInput {
  /** Nombre o alias de una entidad existente, o el nombre de una nueva. */
  nombre: string;
  agregarAlias: string[];
}

export function planEntidad(
  input: EntidadInput,
  snap: ConfigSnapshot,
): Plan<{ antes: EntidadBancaria | null; despues: EntidadBancaria }> {
  const antes = findEntidad(input.nombre, snap.entidades) ?? null;
  const despues: EntidadBancaria = antes
    ? { ...antes, alias: unique([...antes.alias, ...input.agregarAlias]) }
    : {
        id: uniqueId(slugify(input.nombre), new Set(snap.entidades.map((e) => e.id))),
        nombre: input.nombre.trim(),
        alias: unique([input.nombre, ...input.agregarAlias]),
      };

  const parsed = entidadSchema.safeParse(despues);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) };
  const otras = snap.entidades.filter((e) => e.id !== despues.id);
  const { errors } = validateConfig(snap.cuentas, [...otras, despues]);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { antes, despues } };
}

// ── Cuentas ────────────────────────────────────────────────────────────────

/** Datos de crédito tal como los da el usuario (quetzales y porcentaje). */
export interface CreditoInput {
  diaCorte: number | null;
  diaPago: number | null;
  /** Límite en quetzales. */
  limite: number | null;
  /** Tasa en porcentaje (3.5 = 3,5 %). Opcional. */
  tasaInteres: number | null;
  periodoTasa: 'mensual' | 'anual' | null;
}

export interface CrearCuentaInput extends CreditoInput {
  nombre: string;
  tipo: Cuenta['tipo'];
  /** Nombre o alias del banco; si no existe, se crea la entidad. null en efectivo. */
  entidad: string | null;
  alias: string[];
  terminaciones: string[];
  /** Saldo actual en quetzales; en crédito, la DEUDA actual como número positivo. */
  saldoActual: number | null;
}

const tasaToBps = (tasa: number): number => Math.round(tasa * 100);

function semilla(tipo: Cuenta['tipo'], saldoActual: number): number {
  return tipo === 'credito' ? -toCents(Math.abs(saldoActual)) : toCents(saldoActual);
}

export function planCrearCuenta(
  input: CrearCuentaInput,
  snap: ConfigSnapshot,
  today: string,
): Plan<{ cuenta: Cuenta; entidadNueva: EntidadBancaria | null }> {
  const errors: string[] = [];

  let entidadId: string | null = null;
  let entidadNueva: EntidadBancaria | null = null;
  if (input.entidad && input.tipo !== 'efectivo') {
    const existente = findEntidad(input.entidad, snap.entidades);
    if (existente) entidadId = existente.id;
    else {
      entidadNueva = {
        id: uniqueId(slugify(input.entidad), new Set(snap.entidades.map((e) => e.id))),
        nombre: input.entidad.trim(),
        alias: unique([input.entidad]),
      };
      entidadId = entidadNueva.id;
    }
  }

  let credito: Cuenta['credito'];
  if (input.tipo === 'credito') {
    if (input.diaCorte === null) errors.push('Falta el día de corte de la tarjeta.');
    if (input.diaPago === null) errors.push('Falta el día de pago de la tarjeta.');
    if (input.limite === null) errors.push('Falta el límite de la tarjeta.');
    if (errors.length === 0) {
      credito = {
        limiteCentavos: toCents(input.limite!),
        diaCorte: input.diaCorte!,
        diaPago: input.diaPago!,
        ajustePago: 'siguiente_habil',
        diasAviso: [5, 2, 0],
        ...(input.tasaInteres !== null
          ? { interes: { tasaBps: tasaToBps(input.tasaInteres), periodo: input.periodoTasa ?? 'mensual' } }
          : {}),
      };
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const cuenta: Cuenta = {
    id: uniqueId(slugify(input.nombre), new Set(snap.cuentas.map((c) => c.id))),
    nombre: input.nombre.trim(),
    tipo: input.tipo,
    entidadId,
    terminaciones: unique(input.terminaciones),
    alias: unique(input.alias),
    semillaCentavos: input.saldoActual === null ? 0 : semilla(input.tipo, input.saldoActual),
    asOf: today,
    estimada: input.saldoActual === null,
    activa: true,
    ...(credito ? { credito } : {}),
  };

  const parsed = cuentaSchema.safeParse(cuenta);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) };
  const entidades = entidadNueva ? [...snap.entidades, entidadNueva] : snap.entidades;
  const v = validateConfig([...snap.cuentas, cuenta], entidades);
  return v.errors.length > 0 ? { ok: false, errors: v.errors } : { ok: true, value: { cuenta, entidadNueva } };
}

export interface EditarCuentaInput extends CreditoInput {
  /** id, nombre, alias o terminación de la cuenta a editar. */
  cuenta: string;
  nuevoNombre: string | null;
  agregarAlias: string[];
  quitarAlias: string[];
  agregarTerminaciones: string[];
  quitarTerminaciones: string[];
  saldoActual: number | null;
  activa: boolean | null;
}

export function planEditarCuenta(
  input: EditarCuentaInput,
  snap: ConfigSnapshot,
  today: string,
): Plan<{ antes: Cuenta; despues: Cuenta }> {
  const antes = findCuenta(input.cuenta, snap.cuentas);
  if (!antes) {
    const disponibles = snap.cuentas.map((c) => c.nombre).join(', ') || 'ninguna';
    return { ok: false, errors: [`No encontré la cuenta "${input.cuenta}". Cuentas configuradas: ${disponibles}.`] };
  }

  const tocaCredito = [input.diaCorte, input.diaPago, input.limite, input.tasaInteres].some((v) => v !== null);
  if (tocaCredito && antes.tipo !== 'credito') {
    return { ok: false, errors: [`"${antes.nombre}" no es una tarjeta de crédito: no tiene corte, pago, límite ni tasa.`] };
  }

  const quitarAlias = new Set(input.quitarAlias.map(normalizeAlias));
  const quitarTerm = new Set(input.quitarTerminaciones.map((t) => t.trim()));
  const despues: Cuenta = {
    ...antes,
    nombre: input.nuevoNombre?.trim() || antes.nombre,
    alias: unique([...antes.alias, ...input.agregarAlias]).filter((a) => !quitarAlias.has(normalizeAlias(a))),
    terminaciones: unique([...antes.terminaciones, ...input.agregarTerminaciones]).filter((t) => !quitarTerm.has(t)),
    activa: input.activa ?? antes.activa,
    ...(input.saldoActual !== null
      ? { semillaCentavos: semilla(antes.tipo, input.saldoActual), asOf: today, estimada: false }
      : {}),
  };
  if (antes.credito && tocaCredito) {
    despues.credito = {
      ...antes.credito,
      ...(input.diaCorte !== null ? { diaCorte: input.diaCorte } : {}),
      ...(input.diaPago !== null ? { diaPago: input.diaPago } : {}),
      ...(input.limite !== null ? { limiteCentavos: toCents(input.limite) } : {}),
      ...(input.tasaInteres !== null
        ? {
            interes: {
              tasaBps: tasaToBps(input.tasaInteres),
              periodo: input.periodoTasa ?? antes.credito.interes?.periodo ?? 'mensual',
            },
          }
        : {}),
    };
  }

  const parsed = cuentaSchema.safeParse(despues);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error.issues) };
  const otras = snap.cuentas.filter((c) => c.id !== despues.id);
  const v = validateConfig([...otras, despues], snap.entidades);
  return v.errors.length > 0 ? { ok: false, errors: v.errors } : { ok: true, value: { antes, despues } };
}

// ── Resúmenes (HTML de Telegram, valores escapados) ────────────────────────

const ICONO: Record<Cuenta['tipo'], string> = { banco: '🏦', credito: '💳', efectivo: '💵', billetera: '📱' };
const TIPO: Record<Cuenta['tipo'], string> = { banco: 'banco', credito: 'crédito', efectivo: 'efectivo', billetera: 'billetera' };

export function resumenEntidad(e: EntidadBancaria): string {
  return `🏛️ <b>${escapeHtml(e.nombre)}</b> · alias: ${escapeHtml(e.alias.join(', ') || '—')}`;
}

export function resumenCuenta(c: Cuenta, entidades: ReadonlyArray<EntidadBancaria>): string {
  const entidad = c.entidadId ? entidades.find((e) => e.id === c.entidadId) : undefined;
  const cabecera = [
    `${ICONO[c.tipo]} <b>${escapeHtml(c.nombre)}</b>`,
    TIPO[c.tipo],
    ...(entidad ? [escapeHtml(entidad.nombre)] : []),
    ...(c.terminaciones.length > 0 ? [c.terminaciones.map((t) => `••${t}`).join(', ')] : []),
    ...(c.activa ? [] : ['(cerrada)']),
  ].join(' · ');

  const lineas = [cabecera];
  if (c.credito) {
    const interes = c.credito.interes
      ? ` · interés ${c.credito.interes.tasaBps / 100}% ${c.credito.interes.periodo}`
      : '';
    lineas.push(
      `Corte ${c.credito.diaCorte} · pago ${c.credito.diaPago} · límite ${formatCents(c.credito.limiteCentavos)}${interes}`,
    );
    lineas.push(`Deuda: ${formatCents(Math.max(0, -c.semillaCentavos))}${c.estimada ? ' (sin dato aún)' : ''}`);
  } else {
    lineas.push(`Saldo: ${formatCents(c.semillaCentavos)}${c.estimada ? ' (sin dato aún)' : ''}`);
  }
  if (c.alias.length > 0) lineas.push(`Alias: ${escapeHtml(c.alias.join(', '))}`);
  return lineas.join('\n');
}
