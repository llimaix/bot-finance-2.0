import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { config } from '../config';
import { weekdayGT } from '../dates';
import { logger } from '../logger';
import { ACCOUNT_IDS, METHODS, TXN_TYPES } from '../types';
import type { AccountId, ConversationMessage, Transaction } from '../types';
import { getAgentModel, logUsage, stripThinking } from './llm';
import { buildAgentSystemPrompt } from './prompts';
import { newCategorySchema, parsedTransactionSchema } from './schema';

// Tope TOTAL por defecto del loop del agente (varios pasos LLM + herramientas).
// El webhook lo ajusta según la vía: texto (más holgado) vs voz (ya gastó en transcribir).
const DEFAULT_AGENT_TIMEOUT_MS = 20_000;

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
}

export interface AgentResult {
  text: string;
  registered: Transaction[];
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

  const result = await generateText({
    model: getAgentModel(),
    system: buildAgentSystemPrompt({
      today: deps.today,
      weekday: weekdayGT(),
      contextInfo: deps.contextInfo,
    }),
    messages: [
      ...history.map((m) => ({ role: m.role, content: m.text })),
      { role: 'user' as const, content: userText },
    ],
    tools: {
      registrar_movimientos: tool({
        description:
          'Registra movimientos de dinero NUEVOS de Allan (gastos, ingresos, retiros, depósitos, transferencias). NO la uses para movimientos que ya aparecen en el contexto o la conversación, ni cuando Allan está cuadrando/reconciliando sus cuentas: ahí corresponde consultar, corregir o eliminar. Declara en newCategories cualquier categoría nueva que uses.',
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
          'Datos financieros actuales de Allan: saldos por cuenta, neto líquido, pagos recurrentes (con si aún vienen este mes) y agregados de mes/semana. Úsala antes de responder preguntas o dar veredictos.',
        inputSchema: z.object({}),
        execute: async () => deps.snapshot(),
      }),

      ajustar_cuenta: tool({
        description:
          'Corrige el saldo (al cierre de hoy) y/o el nombre de una cuenta cuando Allan lo indique. Deuda de tarjeta en negativo.',
        inputSchema: z.object({
          cuenta: z.enum(ACCOUNT_IDS),
          nuevoSaldo: z.number().nullable(),
          nuevoNombre: z.string().nullable(),
        }),
        execute: async (input) => deps.adjustAccount(input),
      }),

      dia_sin_movimientos: tool({
        description: 'Marca el día como "sin movimientos" cuando Allan lo diga explícitamente.',
        inputSchema: z.object({}),
        execute: async () => {
          await deps.markNoMovements();
          return { ok: true };
        },
      }),

      corregir_movimiento: tool({
        description:
          'Corrige campos de un movimiento YA registrado (por su número del día). Úsala cuando Allan diga que algo quedó mal ("los últimos pagos fueron con débito", "el #3 era Q50"). Solo envía en cambios los campos a modificar (el resto null). fecha null = hoy. Para varios movimientos, llámala una vez por cada uno.',
        inputSchema: z.object({
          numero: z.number().int().positive(),
          fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
          cambios: z.object({
            monto: z.number().nullable(),
            tipo: z.enum(TXN_TYPES).nullable(),
            categoria: z.string().nullable(),
            metodo: z.enum(METHODS).nullable(),
            descripcion: z.string().nullable(),
          }),
        }),
        execute: async (input) => deps.correctMovement(input),
      }),

      eliminar_movimiento: tool({
        description:
          'Elimina un movimiento YA registrado (por su número del día). fecha null = hoy. Confirma con Allan antes si hay ambigüedad sobre cuál borrar.',
        inputSchema: z.object({
          numero: z.number().int().positive(),
          fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        }),
        execute: async (input) => deps.deleteMovement(input),
      }),

      fijar_meta: tool({
        description:
          'Fija (o quita) la meta de gasto mensual de una categoría cuando Allan lo pida ("ponme meta de Q1,500 en comida", "quita la meta de transporte"). topeMensual null = quitar la meta. Las metas vigentes y su avance vienen en consultar_datos (metasDeGasto).',
        inputSchema: z.object({
          categoria: z.string().min(2),
          topeMensual: z.number().positive().nullable(),
        }),
        execute: async (input) => deps.setBudget(input),
      }),

      recordar_dato: tool({
        description:
          'Guarda un hecho DURABLE que Allan comparta o corrija sobre sus finanzas o preferencias ("mi salario cae el 15 y el 29", "FELI es la veterinaria", "mi meta es ahorrar Q2,000/mes"). No para movimientos ni datos pasajeros. Escribe el dato en tercera persona, conciso.',
        inputSchema: z.object({ dato: z.string().min(5) }),
        execute: async ({ dato }) => deps.rememberFact(dato),
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
    },
    stopWhen: stepCountIs(5),
    temperature: 0,
    timeout: opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    // Las respuestas son de ~120 palabras: el tope evita salidas desbocadas.
    maxOutputTokens: 700,
  });

  const text =
    stripThinking(result.text) ||
    (registered.length > 0 ? '✅ Registrado.' : '🤔 No supe qué hacer con eso, ¿me lo repites?');
  // totalUsage: suma de TODOS los pasos del loop (usage es solo el último).
  logUsage('runAgent', config.llmModelAgent, result.totalUsage ?? result.usage, {
    steps: result.steps?.length,
  });
  logger.info('agente completado', {
    userText,
    steps: result.steps?.length,
    registered: registered.length,
    reply: text,
  });
  return { text, registered };
}
