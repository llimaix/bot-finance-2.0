import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { weekdayGT } from '../dates';
import { logger } from '../logger';
import { ACCOUNT_IDS } from '../types';
import type { AccountId, ConversationMessage, Transaction } from '../types';
import { getAgentModel } from './llm';
import { buildAgentSystemPrompt } from './prompts';
import { newCategorySchema, parsedTransactionSchema } from './schema';

// Tope TOTAL del loop del agente (varios pasos LLM + herramientas). Debe caber
// con la transcripción de voz dentro de los 25s de la Lambda webhook.
const AGENT_TIMEOUT_MS = 15_000;

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
          'Registra movimientos de dinero de Allan (gastos, ingresos, retiros, depósitos, transferencias). Declara en newCategories cualquier categoría nueva que uses.',
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
    timeout: AGENT_TIMEOUT_MS,
  });

  const text = result.text.trim() || (registered.length > 0 ? '✅ Registrado.' : '🤔 No supe qué hacer con eso, ¿me lo repites?');
  logger.info('agente completado', {
    userText,
    steps: result.steps?.length,
    registered: registered.length,
    reply: text,
  });
  return { text, registered };
}
