# FUNCIONALIDAD DEL FORK FRENTE AL ORIGINAL

Rama: `chore/fork-original`. Base: commit `b3d9e07` de `Allan-Sanchez/bot-finance`.
Última actualización: 2026-11-22.

Este documento compara **solo la funcionalidad** del bot: qué hace para el usuario. Los cambios de infraestructura y despliegue se resumen al final, como referencia.

---

## 1. FUNCIONALIDAD ACTUAL

El fork conserva todas las funciones del original. La columna "Cambio en el fork" indica si alguna se comporta distinto.

| Área | Función | Original | Fork | Cambio en el fork |
|---|---|---|---|---|
| Registro | Movimientos por texto libre ("almuerzo Q45 en efectivo") | ✅ | ✅ | Sin cambios |
| Registro | Movimientos por nota de voz (Amazon Transcribe, `es-US`) | ✅ | ✅ | Si la voz consume tiempo, el agente ajusta su presupuesto (M5) |
| Registro | Comprobantes por foto (visión) | ✅ | ✅ | El modelo de visión pasa a MiniMax-M3 |
| Registro | Pagos en USD convertidos a quetzales (`USD_GTQ_RATE`, 7,80 por defecto) | ✅ | ✅ | Sin cambios |
| Registro | Fechas retroactivas ("ayer", "el lunes", hasta un año atrás) | ✅ | ✅ | Sin cambios |
| Registro | Red de seguridad: registra por parser si el agente no escribió | ✅ | ✅ | Ya no duplica tras un reintento (M4) y se omite si no hay tiempo (M5) |
| Edición | Corregir un movimiento en lenguaje natural ("corrige #2, eran Q50") | ✅ | ✅ | Rechaza montos negativos o cero (M3) |
| Edición | Borrar con el botón 🗑️ o con `/borrar N` | ✅ | ✅ | Sin cambios |
| Agente | Preguntas libres y asesoría ("¿me alcanza para…?") | ✅ | ✅ | El agente usa MiniMax-M3 en lugar de Claude Sonnet |
| Agente | Instrucciones y hechos aprendidos ("mi salario cae el 15") | ✅ | ✅ | Sin cambios |
| Agente | Memoria conversacional de corto plazo (12 intercambios, 72 h) | ✅ | ✅ | Sin cambios |
| Categorías | Catálogo dinámico: crea categorías nuevas y evita duplicados | ✅ | ✅ | Sin cambios |
| Consulta | `/hoy`, `/semana`, `/mes` | ✅ | ✅ | Sin cambios |
| Consulta | `/reporte`: reporte del mes con análisis de la IA | ✅ | ✅ | Narrativa generada con MiniMax-M3 |
| Consulta | `/saldo`: saldos por cuenta y neto líquido; `/saldo <cuenta> <monto>` ajusta la semilla | ✅ | ✅ | Sin cambios (cuentas fijas del original) |
| Consulta | `/proyeccion`: disponible proyectado a fin de mes | ✅ | ✅ | Sin cambios |
| Consulta | `/metas`: metas de gasto por categoría con semáforo; `/metas sugerir` | ✅ | ✅ | Sin cambios |
| Consulta | `/recurrentes`: gastos recurrentes aprendidos | ✅ | ✅ | Sin cambios |
| Consulta | `/costo`: costo de la IA del mes por modelo y función | ✅ | ✅ | Calcula con las tarifas de MiniMax-M3 (ya estaban en el código) |
| Consulta | `/memoria`: hechos aprendidos con borrado por botones | ✅ | ✅ | Sin cambios |
| Consulta | `/categorias`, `/ayuda` | ✅ | ✅ | Sin cambios |
| Consulta | `/export`: mes en curso como CSV | ✅ | ✅ | Sin cambios |
| Día | `/nada` u "hoy nada": día sin movimientos | ✅ | ✅ | Sin cambios |
| Automático | Recordatorio diario 17:00 | ✅ | ✅ | Sin cambios |
| Automático | Seguimiento 21:00 si no hubo respuesta | ✅ | ✅ | Sin cambios |
| Automático | Guardián financiero 08:30 (solo habla si hay hallazgos) | ✅ | ✅ | Sin cambios |
| Automático | Resumen semanal con coach, domingo 20:00 | ✅ | ✅ | Coach generado con MiniMax-M3 |
| Automático | Plan de quincena 08:00, en la víspera del 15 y del fin de mes | ✅ | ✅ | Sin cambios (calendario de pago del original) |
| Automático | Reporte mensual, día 1 a las 08:00 | ✅ | ✅ | Sin cambios |
| Seguridad | Solo responde a un chat permitido (`allowed_chat_id`) | ✅ | ✅ | Sin cambios |
| Seguridad | Webhook validado con secret token de Telegram | ✅ | ✅ | Sin cambios |
| Fiabilidad | Cada update se procesa una sola vez (idempotencia por `update_id`) | ✅ | ✅ | Sin cambios |
| Fiabilidad | Aviso al usuario si el procesamiento falla | ✅ | ✅ | Ahora también avisa antes de un timeout de la Lambda (M5) |

Todas las horas son de Guatemala (`America/Guatemala`).

---

## 2. MEJORAS FUNCIONALES APLICADAS

Cambios de comportamiento respecto al original, con su referencia en `docs/analisis-bot-finance.md` (rama `main`).

| ID | Problema en el original | Comportamiento en el fork | Commit |
|---|---|---|---|
| M3 | `corregir_movimiento` aceptaba montos negativos o cero. Un `-50` invertía el signo en todos los saldos y un `0` anulaba el movimiento | El esquema exige monto positivo y `correctMovement` lo valida otra vez. El agente recibe un error y puede pedir aclaración en lugar de corromper los saldos | `f68556f` |
| M4 | Si el primer intento del agente corregía un movimiento y el reintento no escribía, la red de seguridad registraba un **duplicado** | La detección de herramientas de escritura acumula todos los intentos del turno, así que no hay doble registro | `ee7f1b4` |
| M5 | Si la Lambda cortaba por timeout (agente, reintento, red de seguridad y voz sumaban más de 180 s), el mensaje se perdía **sin avisar** | Cada fase larga ajusta su timeout al tiempo restante o se omite. Si aun así el trabajo no termina, el bot avisa 8 s antes del corte: "⏳ Me quedé sin tiempo… Revisa /hoy antes de reenviarlo" | `c88921e` |
| H2 | Los logs guardaban el texto completo de los mensajes, las respuestas, las transcripciones, los hechos aprendidos y los montos | El logger redacta esas claves y solo registra el tipo y la longitud. Los logs se conservan 30 días en lugar de indefinidamente | `f116b7c` |
| — | Proveedor de IA por defecto: Anthropic (Claude Haiku y Sonnet) | MiniMax-M3 para texto, agente y visión. Es la misma funcionalidad, con otro modelo. Se cambia con la variable `llm_provider` de los roots de Lambda, sin tocar código | Configuración en `infra/` |

---

## 3. LO QUE SIGUE IGUAL A PROPÓSITO

Comportamientos del original que el fork mantiene sin tocar, porque se rediseñan en la versión 2.0:

| Comportamiento | Detalle |
|---|---|
| Cuentas fijas | BI, Banrural, tarjeta, efectivo y kash, con reglas como "BI = débito" (`types.ts`, `accounts.ts`, `guards.ts`). La 2.0 las sustituye por cuentas dinámicas |
| Calendario de pago | 15 y último día del mes, ajustados a día hábil (`dates.ts`). La 2.0 lo sustituye por ingresos configurables |
| Nombre del usuario | Los prompts y las descripciones de herramientas se refieren al usuario como "Allan" (`prompts.ts`, `agent.ts` y otros) |
| Clave de partición | Todos los datos usan `PK = USER#allan` (`dynamo.ts`) |
| Menú de comandos de Telegram | `set-webhook.mjs` registra 13 comandos y `BOT_COMMANDS` define 15: faltan `/metas` y `/costo` en el menú. Los comandos funcionan igual si se escriben |
| Hallazgos bajos del análisis | Escrituras que pueden pisarse y otros detalles menores, sin cambios |

---

## 4. CAMBIOS NO FUNCIONALES (REFERENCIA)

No cambian lo que hace el bot, sino cómo se despliega y opera:

- Estructura: `backend/` (código), `infra/` (Terraform con módulos y un root por componente) y `bootstrap/` (CloudFormation del state y el rol OIDC).
- Despliegue solo por pipelines: `terraform` (detección por root, plan, aprobación y apply), `lambdas` (detección por metafile de esbuild y matriz por función) y `telegram-webhook` (manual).
- Secretos en Secrets Manager, leídos en tiempo de ejecución; Terraform solo conoce sus nombres (H1).
- Throttling de la API: 5 peticiones por segundo con ráfaga de 10 (M2).
- Alarmas de errores por Lambda con aviso por correo al fallar y al recuperarse.
- Budget mensual de $10 filtrado por el tag `Project=bot-finance`, con kill switch automático (M1, mejorado). El gasto en MiniMax no pasa por AWS.
- Permisos mínimos por Lambda y permissions boundary obligatorio en todos los roles.
