import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { config } from '../config';
import { weekdayGT } from '../dates';
import { fits, remainingMs } from '../deadline';
import { logger } from '../logger';
import { ACCOUNT_IDS, METHODS, TXN_TYPES } from '../types';
import type { AccountId, ConversationMessage, Transaction } from '../types';
import { getAgentModel, logUsage, stripThinking } from './llm';
import { buildAgentSystemPrompt } from './prompts';
import { newCategorySchema, parsedTransactionSchema } from './schema';

// Tope TOTAL por defecto del loop del agente (varios pasos LLM + herramientas).
// El webhook lo ajusta según la vía: texto (más holgado) vs voz (ya gastó en transcribir).
const DEFAULT_AGENT_TIMEOUT_MS = 20_000;
/** Timeout del reintento con empujón; solo se intenta si cabe en el presupuesto (M5). */
const RETRY_TIMEOUT_MS = 60_000;

/**
 * "Anuncio sin acción": los modelos razonadores a veces responden "espera un
 * momento, estoy consultando..." SIN llamar ninguna herramienta — el loop
 * termina y el usuario recibe una promesa vacía (incidente 14-jul, "Dame mi
 * estatus"). Si el texto final huele a promesa y no hubo herramientas, se
 * reintenta UNA vez con un empujón explícito.
 */
// "espera" es ambiguo: anuncio ("esperá un momento") vs consejo ("espera hasta
// el 8 de agosto"). Solo cuenta como anuncio si le sigue el contexto de espera
// ("un momento", "mientras...", "a que reviso") — no un bare "espera" que
// también aparece en recomendaciones legítimas (validación 21-jul).
export const ANNOUNCE_RE =
  /un momento|un segundo|esper[aá](?:me|nos)?\s+(?:un|unos|tantito|mientras|a que|en lo que|que (?:reviso|consulto|verifico|busco))|estoy (?:consultando|revisando|buscando|verificando)|voy a (?:consultar|revisar|buscar|verificar)|d[eé]jame (?:ver|revisar|consultar)/i;

/**
 * "Afirmación sin escritura": la variante retrospectiva del mismo mal — el
 * modelo dice "✅ Registrado" SIN haber llamado ninguna herramienta (incidente
 * 15/17-jul: la quincena de Q7,500 y el pago total de la tarjeta jamás se
 * guardaron pese a confirmaciones triunfales). Si el texto afirma una acción
 * y no hubo herramienta de ESCRITURA, se reintenta; si persiste, el sistema
 * estampa la verdad — el usuario nunca debe creer guardado lo que no lo está.
 */
// Sin \b final: las formas en 1ª persona ("registré", "marqué") terminan en
// vocal acentuada, que no es carácter de palabra y rompería el boundary.
export const CLAIM_RE =
  /✅|\bregistr(?:ad[oa]s?|[eé])|\banot(?:ad[oa]s?|[eé])|\bguard(?:ad[oa]s?|[eé])|\bagreg(?:ad[oa]s?|u[eé])|\ba[ñn]adid[oa]s?|\bapunt(?:ad[oa]s?|[eé])|\bajust(?:ad[oa]s?|[eé])|\belimin(?:ad[oa]s?|[eé])|\bborr(?:ad[oa]s?|[eé])|\bmarc(?:ad[oa]s?)|\bmarqu[eé]|\bhecho\b|paso a memoria|lo apunto|qued[oó] (?:guardad|registrad|anotad|apuntad|marcad)|sale de tu (?:efectivo|cuenta|saldo)/i;

const WRITE_TOOLS = new Set([
  'registrar_movimientos',
  'corregir_movimiento',
  'eliminar_movimiento',
  'ajustar_cuenta',
  'fijar_meta',
  'recordar_dato',
  'dia_sin_movimientos',
  'marcar_recurrente_pagado',
  'configurar_perfil',
]);

export const NO_WRITE_DISCLAIMER =
  '\n\n⚠️ Nota del sistema: en este turno no guardé ni cambié ningún dato. Si esperabas un registro, vuelve a pedírmelo.';

/** El mensaje del usuario pide REGISTRAR un movimiento (gasto/ingreso/retiro…):
 *  señal para activar la red de seguridad si el agente afirma sin ejecutar. */
export const REGISTER_INTENT_RE =
  /\b(gast|pagu[eé]|pag(?:o|u[eé]|amos|ad)|compr|retir|dep[oó]sit|deposit|ingres|me cay[oó]|cobr|registr|anot)\w*/i;

/** Afirmación de ESCRITURA (registrar/ajustar/marcar…), SIN el ✅ suelto: los
 *  veredictos de compra empiezan con "✅ Sí te alcanza" y NO son una escritura.
 *  Las formas en -é exigen la tilde: "borré/registré" (pasado, afirmación) pero
 *  NO "¿que los borre?"/"que registre" (subjuntivo de una pregunta). */
export const WRITE_CLAIM_RE =
  /\bregistr(?:ad[oa]s?|é)|\banot(?:ad[oa]s?|é)|\bguard(?:ad[oa]s?|é)|\bagreg(?:ad[oa]s?|ué)|\ba[ñn]adid[oa]s?|\bapunt(?:ad[oa]s?|é)|\bajust(?:ad[oa]s?|é)|\belimin(?:ad[oa]s?|é)|\bborr(?:ad[oa]s?|é)|\bmarc(?:ad[oa]s?)|\bmarqué|(?<!de )\bhecho\b|paso a memoria|lo apunto|qued[oó] (?:guardad|registrad|anotad|apuntad|marcad)|sale de tu (?:efectivo|cuenta|saldo)/i;

/**
 * ¿Debe la red de seguridad determinista intentar registrar? SOLO si el agente
 * NO escribió NADA (ni corregir/ajustar/marcar — mirar la ESCRITURA, no solo
 * registrar_movimientos) y el mensaje del usuario pedía registrar. Sin el
 * primer control, un "corrígelo a Q60" (corregir_movimiento) re-registraba un
 * gasto nuevo duplicado.
 */
/** Forma mínima de un intento del agente que necesita `toolUsage`. */
interface AttemptSteps {
  steps?: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string }> }>;
}

/**
 * Herramientas usadas en TODOS los intentos del turno (primer intento y
 * reintento). Mirar solo el último perdía escrituras del primero: si este
 * corregía un movimiento y el reintento no escribía, usedWriteTool quedaba en
 * false y la red de seguridad registraba un duplicado.
 */
export function toolUsage(attempts: ReadonlyArray<AttemptSteps>): { usedAnyTool: boolean; usedWriteTool: boolean } {
  const calls = attempts.flatMap((a) => (a.steps ?? []).flatMap((s) => s.toolCalls ?? []));
  return {
    usedAnyTool: calls.length > 0,
    usedWriteTool: calls.some((tc) => WRITE_TOOLS.has(tc.toolName)),
  };
}

export function needsDeterministicRegister(usedWriteTool: boolean, userText: string): boolean {
  return !usedWriteTool && REGISTER_INTENT_RE.test(userText);
}

/** ¿Estampar "no guardé nada"? Si el agente afirmó una ESCRITURA y no la hizo.
 *  Se mira usedWriteTool (no usedAnyTool): una consulta previa no borra la
 *  mentira de "✅ Registrado". */
export function needsNoWriteDisclaimer(usedWriteTool: boolean, replyText: string): boolean {
  return !usedWriteTool && WRITE_CLAIM_RE.test(replyText);
}

/**
 * Campos que `corregir_movimiento` puede cambiar. El monto debe ser positivo:
 * el signo lo da `tipo`, y un -50 o un 0 del modelo invertiría o anularía los
 * saldos (la otra ruta de corrección, parse.ts, ya exige > 0).
 */
export const correctionChangesSchema = z.object({
  monto: z.number().positive().nullable(),
  tipo: z.enum(TXN_TYPES).nullable(),
  categoria: z.string().nullable(),
  metodo: z.enum(METHODS).nullable(),
  descripcion: z.string().nullable(),
});

export interface RegisteredBatch {
  txns: Transaction[];
  createdCategories: Array<{ name: string; emoji: string }>;
  totalSpentToday: number;
  /** Escudos: posibles duplicados o montos inusuales (menciónalos al usuario). */
  advertencias: string[];
}

export interface AgentDeps {
  today: string;
  /** Cuentas con saldos + catálogo + hechos aprendidos, formateado para el system prompt. */
  contextInfo: string;
  register: (input: {
    transactions: Array<z.infer<typeof parsedTransactionSchema>>;
    newCategories: Array<z.infer<typeof newCategorySchema>>;
  }) => Promise<RegisteredBatch>;
  snapshot: () => Promise<unknown>;
  adjustAccount: (input: {
    cuenta: AccountId;
    nuevoSaldo: number | null;
    nuevoNombre: string | null;
  }) => Promise<unknown>;
  markNoMovements: () => Promise<void>;
  rememberFact: (dato: string) => Promise<unknown>;
  /** Cambia el nombre con el que el bot se dirige al usuario (perfil CFG#perfil). */
  setUserName: (nombre: string) => Promise<unknown>;
  searchMovements: (input: {
    desde: string;
    hasta: string;
    categoria: string | null;
    texto: string | null;
  }) => Promise<unknown>;
  correctMovement: (input: {
    numero: number;
    fecha: string | null;
    cambios: {
      monto: number | null;
      tipo: (typeof TXN_TYPES)[number] | null;
      categoria: string | null;
      metodo: (typeof METHODS)[number] | null;
      descripcion: string | null;
    };
  }) => Promise<unknown>;
  deleteMovement: (input: { numero: number; fecha: string | null }) => Promise<unknown>;
  setBudget: (input: { categoria: string; topeMensual: number | null }) => Promise<unknown>;
  markRecurringPaid: (input: { descripcion: string }) => Promise<unknown>;
}

export interface AgentResult {
  text: string;
  registered: Transaction[];
  /** true si el agente llamó ALGUNA herramienta (para decidir si una
   *  afirmación de acción fue real o alucinada). */
  usedAnyTool: boolean;
  /** true si llamó alguna herramienta de ESCRITURA (registrar/corregir/…). */
  usedWriteTool: boolean;
}

/**
 * Agente conversacional del webhook: el modelo decide si registrar, consultar
 * datos, ajustar cuentas o simplemente responder, con memoria de los últimos
 * mensajes. Los números siguen saliendo del código (las herramientas).
 */
export async function runAgent(
  userText: string,
  history: ConversationMessage[],
  deps: AgentDeps,
  opts: { timeoutMs?: number } = {},
): Promise<AgentResult> {
  const registered: Transaction[] = [];

  const system = buildAgentSystemPrompt({
    today: deps.today,
    weekday: weekdayGT(),
    contextInfo: deps.contextInfo,
  });
  const baseMessages = [
    ...history.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user' as const, content: userText },
  ];
  const agentTools = {
      registrar_movimientos: tool({
        description:
          'Registra movimientos de dinero NUEVOS del usuario (gastos, ingresos, retiros, depósitos, transferencias). NO la uses para movimientos que ya aparecen en el contexto o la conversación, ni cuando el usuario está cuadrando/reconciliando sus cuentas: ahí corresponde consultar, corregir o eliminar. Declara en newCategories cualquier categoría nueva que uses.',
        inputSchema: z.object({
          transactions: z.array(parsedTransactionSchema).min(1),
          newCategories: z.array(newCategorySchema),
        }),
        execute: async (input) => {
          const batch = await deps.register(input);
          registered.push(...batch.txns);
          return {
            ok: true,
            registrados: batch.txns.map((t) => ({
              numero: t.shortId,
              fecha: t.date,
              monto: t.amount,
              categoria: t.category,
              descripcion: t.description,
            })),
            categoriasNuevas: batch.createdCategories.map((c) => c.name),
            totalGastadoHoy: batch.totalSpentToday,
            ...(batch.advertencias.length > 0 ? { advertencias: batch.advertencias } : {}),
          };
        },
      }),

      consultar_datos: tool({
        description:
          'Datos financieros actuales del usuario: saldos por cuenta, neto líquido, pagos recurrentes (con si aún vienen este mes) y agregados de mes/semana. Úsala antes de responder preguntas o dar veredictos.',
        inputSchema: z.object({}),
        execute: async () => deps.snapshot(),
      }),

      ajustar_cuenta: tool({
        description:
          'Corrige el saldo (al cierre de hoy) y/o el nombre de una cuenta cuando el usuario lo indique. Deuda de tarjeta en negativo.',
        inputSchema: z.object({
          cuenta: z.enum(ACCOUNT_IDS),
          nuevoSaldo: z.number().nullable(),
          nuevoNombre: z.string().nullable(),
        }),
        execute: async (input) => deps.adjustAccount(input),
      }),

      dia_sin_movimientos: tool({
        description: 'Marca el día como "sin movimientos" cuando el usuario lo diga explícitamente.',
        inputSchema: z.object({}),
        execute: async () => {
          await deps.markNoMovements();
          return { ok: true };
        },
      }),

      corregir_movimiento: tool({
        description:
          'Corrige campos de un movimiento YA registrado (por su número del día). Úsala cuando el usuario diga que algo quedó mal ("los últimos pagos fueron con débito", "el #3 era Q50"). Solo envía en cambios los campos a modificar (el resto null). fecha null = hoy. Para varios movimientos, llámala una vez por cada uno.',
        inputSchema: z.object({
          numero: z.number().int().positive(),
          fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
          cambios: correctionChangesSchema,
        }),
        execute: async (input) => deps.correctMovement(input),
      }),

      eliminar_movimiento: tool({
        description:
          'Elimina un movimiento YA registrado (por su número del día). fecha null = hoy. Confirma con el usuario antes si hay ambigüedad sobre cuál borrar.',
        inputSchema: z.object({
          numero: z.number().int().positive(),
          fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        }),
        execute: async (input) => deps.deleteMovement(input),
      }),

      marcar_recurrente_pagado: tool({
        description:
          'Marca un gasto recurrente como YA PAGADO este mes cuando el usuario lo confirme ("Tigo ya está pagado", "eso ya lo pagué") y NO haya que registrar un movimiento nuevo (es un cargo automático ya reflejado en sus saldos). Silencia el recordatorio del guardián sin tocar montos. Da la descripción del recurrente tal como aparece en sus datos.',
        inputSchema: z.object({ descripcion: z.string().min(2) }),
        execute: async (input) => deps.markRecurringPaid(input),
      }),

      fijar_meta: tool({
        description:
          'Fija (o quita) la meta de gasto mensual de una categoría cuando el usuario lo pida ("ponme meta de Q1,500 en comida", "quita la meta de transporte"). topeMensual null = quitar la meta. Las metas vigentes y su avance vienen en consultar_datos (metasDeGasto).',
        inputSchema: z.object({
          categoria: z.string().min(2),
          topeMensual: z.number().positive().nullable(),
        }),
        execute: async (input) => deps.setBudget(input),
      }),

      recordar_dato: tool({
        description:
          'Guarda un hecho DURABLE que el usuario comparta o corrija sobre sus finanzas o preferencias ("mi salario cae el 15 y el 29", "FELI es la veterinaria", "mi meta es ahorrar Q2,000/mes"). No para movimientos ni datos pasajeros. Escribe el dato en tercera persona, conciso.',
        inputSchema: z.object({ dato: z.string().min(5) }),
        execute: async ({ dato }) => deps.rememberFact(dato),
      }),

      configurar_perfil: tool({
        description:
          'Cambia el nombre con el que te diriges al usuario, cuando lo pida explícitamente ("llámame Luis", "mi nombre es Ana", "dime Luis Fernando"). Solo el nombre, sin apodos inventados ni títulos. No lo uses para hechos financieros (eso es recordar_dato).',
        inputSchema: z.object({ nombre: z.string().min(1).max(40) }),
        execute: async ({ nombre }) => deps.setUserName(nombre),
      }),

      buscar_movimientos: tool({
        description:
          'Busca en TODO el historial de movimientos por rango de fechas (yyyy-mm-dd), con filtros opcionales de categoría y texto en la descripción. Úsala para preguntas históricas que el snapshot no cubre ("¿cuánto gasté en farmacias en mayo?"). Devuelve totales por tipo, gastos por categoría y hasta 20 movimientos.',
        inputSchema: z.object({
          desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          categoria: z.string().nullable(),
          texto: z.string().nullable(),
        }),
        execute: async (input) => deps.searchMovements(input),
      }),
  };

  const run = (messages: typeof baseMessages, timeout: number) =>
    generateText({
      model: getAgentModel(),
      system,
      messages,
      tools: agentTools,
      stopWhen: stepCountIs(5),
      temperature: 0,
      timeout,
      // OJO: en modelos razonadores el PENSAMIENTO cuenta como salida — con 700
      // el <think> consumía todo y el texto visible quedaba vacío (incidente
      // 14-jul). 4000 da aire de sobra; a precios de M3 son ~$0.005.
      maxOutputTokens: 4000,
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(baseMessages, opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS);
  } catch (err) {
    // Timeout u otro fallo TRAS haber persistido movimientos: los txns ya
    // están en Dynamo (los escribió el tool). No descartarlos ni reportar
    // fallo total — eso hacía que el usuario reescribiera y se duplicara.
    if (registered.length > 0) {
      logger.warn('runAgent falló tras registrar; confirmo lo persistido', {
        userText,
        error: err instanceof Error ? err.message : String(err),
        registered: registered.length,
      });
      return { text: '✅ Registrado.', registered, usedAnyTool: true, usedWriteTool: true };
    }
    throw err;
  }
  const fallback = () =>
    registered.length > 0 ? '✅ Registrado.' : '🤔 No supe qué hacer con eso, ¿me lo repites?';
  let text = stripThinking(result.text) || fallback();
  // totalUsage: suma de TODOS los pasos del loop (usage es solo el último).
  logUsage('runAgent', config.llmModelAgent, result.totalUsage ?? result.usage, {
    steps: result.steps?.length,
  });

  // Tres variantes del mismo mal (modelos razonadores): (a) promesa vacía sin
  // herramientas ("espera un momento..."), (b) loop terminado SIN texto final
  // y sin nada registrado, (c) AFIRMAR una acción ("✅ Registrado") sin haber
  // llamado ninguna herramienta de escritura. Máximo UN reintento por turno
  // (presupuesto de tiempo del processor); si la afirmación falsa persiste,
  // el sistema estampa la verdad en el mensaje.
  // Todos los intentos del turno: la detección de herramientas se acumula.
  const attempts: Array<typeof result> = [result];
  const retryWith = async (nudge: string) => {
    result = await run(
      [...baseMessages, { role: 'assistant' as const, content: text }, { role: 'user' as const, content: nudge }],
      RETRY_TIMEOUT_MS,
    );
    logUsage('runAgent', config.llmModelAgent, result.totalUsage ?? result.usage, {
      steps: result.steps?.length,
      retry: true,
    });
    attempts.push(result);
    text = stripThinking(result.text) || text;
  };

  // Promesa vacía ("espera un momento...") o loop terminado sin texto útil:
  // un reintento con empujón. (Las AFIRMACIONES falsas de registro las cubre
  // la red de seguridad DETERMINISTA en processing.ts, no un reintento a M3 —
  // reintentar producía disculpas confusas en consultas de lectura.)
  const emptyReply = stripThinking(result.text) === '' && registered.length === 0;
  const needsRetry = (!toolUsage([result]).usedAnyTool && ANNOUNCE_RE.test(text)) || emptyReply;
  if (needsRetry && !fits(RETRY_TIMEOUT_MS)) {
    // M5: el reintento no cabe antes del límite de la invocación. Mejor
    // responder con el fallback que dejar que Lambda corte sin avisar.
    logger.warn('reintento del agente omitido por falta de tiempo', { restanteMs: remainingMs(), emptyReply });
  } else if (needsRetry) {
    logger.warn('agente sin respuesta útil: reintento con empujón', { userText, reply: text, emptyReply });
    try {
      await retryWith(
        'Responde AHORA directamente lo que te pregunté, usando las herramientas que hagan falta. Si es una decisión, empieza con tu recomendación y sus razones. No me pidas esperar, no respondas vacío y no me des un volcado de datos.',
      );
    } catch (err) {
      // Si el reintento falla pero el primer intento YA registró, no perderlo:
      // text ya es el fallback "✅ Registrado.". Sin registro previo, propaga.
      if (registered.length === 0) throw err;
      logger.warn('reintento falló tras registrar; confirmo lo previo', {
        userText,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('agente completado', {
    userText,
    steps: result.steps?.length,
    registered: registered.length,
    reply: text,
  });
  return { text, registered, ...toolUsage(attempts) };
}
