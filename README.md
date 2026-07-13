# finanzas-web 💰

Bot de Telegram para registrar finanzas personales (quetzales, GTQ) con mínima fricción: le escribes o le mandas una **nota de voz** con los movimientos del día, la IA los estructura y quedan guardados en DynamoDB. Incluye recordatorios diarios, comandos de consulta y un reporte mensual con análisis.

## Arquitectura

```
Telegram ──webhook──▶ API Gateway ──▶ Lambda webhook (fina, 10s: valida/dedupe/filtra)
                                          │ invoca async
                                          ▼
                                      Lambda processor (120s) ──▶ DynamoDB (single-table)
                                          ├─ Agente con herramientas (LLM_MODEL_AGENT) → registrar,
                                          │   consultar, corregir, borrar, ajustar cuentas, recordar hechos
                                          ├─ AI SDK (LLM_PROVIDER) → visión de tickets/corrección/narrativa
                                          └─ STT (STT_PROVIDER)   → transcripción de voz
EventBridge Scheduler (hora de Guatemala)
  ├─ 08:30 diario     ──▶ Lambda reminder (guardián: solo habla si hay hallazgos —
  │                        saldos negativos, recurrentes vencidos, proyección en rojo,
  │                        metas de gasto reventadas)
  ├─ 17:00 diario     ──▶ Lambda reminder (recordatorio)
  ├─ 21:00 diario     ──▶ Lambda reminder (seguimiento solo si no respondiste)
  ├─ 20:00 domingo    ──▶ Lambda reminder (resumen semanal + COACH: análisis y consejos)
  ├─ 08:00 día 14 y 28──▶ Lambda reminder (plan de quincena: cuánto apartar antes del pago)
  └─ 08:00 día 1      ──▶ Lambda monthly-report (reporte del mes cerrado)
```

- **Stack**: Node.js 24 + TypeScript, AWS CDK v2, pnpm, Vitest.
- **IA agnóstica de proveedor**: [Vercel AI SDK](https://ai-sdk.dev). Dos modelos por propósito: `LLM_MODEL` (`claude-haiku-4-5`) para visión/correcciones/narrativa y `LLM_MODEL_AGENT` (`claude-sonnet-5`) para el loop del agente. Cambiar a OpenAI/MiniMax/Google es instalar el provider y cambiar env vars (ver abajo).
- **Voz**: Amazon Transcribe **streaming** (`ogg-opus` directo, español `es-US`) — sin S3, detrás de un puerto intercambiable (`src/lib/stt/`).
- **Webhook asíncrono**: la Lambda del webhook responde a Telegram en milisegundos y delega el trabajo pesado (IA, visión, voz) a una Lambda processor con 120s de margen — sin timeouts de cara a Telegram.
- **Deploy**: automático con GitHub Actions en cada push a `main` (environment `production` + OIDC, sin access keys).
- **Resiliencia**: tabla con Point-in-Time Recovery (restaurable a cualquier segundo de los últimos 35 días) y alarmas de errores por Lambda → correo vía SNS.
- **Costo**: free tier / centavos al mes (DynamoDB on-demand, Lambdas arm64, sin recursos provisioned).

## Comandos del bot

| Comando | Qué hace |
|---|---|
| (texto o voz libre) | Registra movimientos: "almuerzo Q45 en efectivo y Q200 de gasolina con la de crédito" |
| 📸 (foto de ticket) | Lee el comprobante con visión: total, comercio, fecha y método; el caption da contexto ("con la de crédito") |
| "ayer gasté..." | Fechas retroactivas: "ayer", "el lunes", "el 5 de julio" registran en la fecha real (hasta 1 año atrás) |
| `/nada` (o "hoy nada") | Marca el día sin movimientos (apaga el seguimiento de las 21:00) |
| `/export` | El mes en curso como archivo CSV (Excel) |
| `/hoy` | Movimientos del día |
| `/semana` | Resumen de los últimos 7 días por categoría |
| `/mes` | Resumen del mes en curso |
| `/reporte` | Reporte completo del mes en curso con análisis de la IA |
| ❓ (pregunta libre) | "¿Cuánto tengo?", "¿cuánto gasté en farmacias en mayo?", "¿me alcanza para una Play 5?" — el agente consulta tus datos (saldos, recurrentes, búsqueda histórica) y **asesora** con veredicto |
| 💬 (instrucciones y hechos) | "En Banrural solo tengo 40" ajusta la cuenta; "mi salario cae el 15 y el 29" queda **aprendido para siempre** (`/memoria` para ver/olvidar) |
| `/memoria` | Hechos que el agente aprendió de ti, con borrado por botones |
| `/saldo` | Saldos por cuenta (BI, Banrural, tarjeta, efectivo, kash) + neto líquido. Ajusta semillas: `/saldo efectivo 350` |
| `/proyeccion` | Disponible proyectado a fin de mes: neto + ingresos confirmados que faltan − compromisos pendientes − gasto variable proyectado (todo calculado en código) |
| `/metas` | Metas de gasto por categoría con semáforo 🟢🟡🔴. `/metas sugerir` propone topes desde tu historial (confirmas por botones); `/metas comida 1500` fija directo; también por chat: "ponme meta de Q1,500 en comida" |
| `/categorias` | Ver la base de conocimientos de categorías |
| `/borrar N` | Elimina el movimiento #N de hoy (o usa el botón 🗑️ bajo cada confirmación) |
| `corrige #N ...` | Corrige un movimiento en lenguaje natural: "corrige #2 eran Q50 con débito" |

Cada confirmación trae **botones inline** `🗑️ #N` para borrar al toque.

**Coach proactivo**: los domingos 20:00 llega el resumen semanal con análisis del coach (qué cambió vs la semana pasada, cómo va el mes y 2-3 acciones concretas); los días 14 y 28 a las 08:00 —víspera de las quincenas— llega el **plan de quincena** (cuánto apartar para compromisos + colchón antes de gastar). Los números se calculan en código; el LLM solo redacta el consejo.

## Setup inicial (una sola vez)

### 1. Crear el bot con BotFather

1. En Telegram, habla con [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Dale nombre y username. Guarda el **token** (`123456:ABC-DEF...`).

### 2. Obtener tu chat_id

1. Mándale cualquier mensaje a tu bot recién creado.
2. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador.
3. Copia `result[0].message.chat.id` — ese número es tu `ALLOWED_CHAT_ID`.

### 3. API key del proveedor de IA

Crea una API key en [console.anthropic.com](https://console.anthropic.com) (o la del proveedor que elijas).

### 4. Bootstrap de AWS (con tus credenciales locales)

```bash
pnpm install
pnpm cdk bootstrap                # una vez por cuenta/región
pnpm cdk deploy GithubOidcStack -c githubRepo=<owner>/<repo>
```

El output `DeployRoleArn` es el ARN del rol que asumirá GitHub Actions.

### 5. Repo de GitHub + environment `production`

1. Crea el repo y haz push de este proyecto a `main` (el primer push ya intenta deployar; configura el environment antes o relanza el workflow después).
2. En **Settings → Environments → New environment** crea `production`.
3. Agrega los **secrets** del environment:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` — inventa uno largo, solo `A-Za-z0-9_-` (p.ej. `openssl rand -hex 32`)
   - `ANTHROPIC_API_KEY`
   - `ALLOWED_CHAT_ID`
4. Agrega la **variable** del environment:
   - `AWS_DEPLOY_ROLE_ARN` = el `DeployRoleArn` del paso 4.

### 6. Listo

Cada push a `main` corre typecheck + tests + synth y deploya. El último paso del workflow registra el webhook en Telegram automáticamente (`setWebhook` con el secret token). Mándale un mensaje al bot: *"gasté Q45 en almuerzo en efectivo"*.

## Cambiar de proveedor de IA (sin tocar código)

El único punto de acoplamiento es `src/lib/ai/llm.ts` (LLM) y `src/lib/stt/index.ts` (voz). Los proveedores **ya implementados** se alternan solo con configuración del environment `production` de GitHub:

**Pasar a MiniMax (ya soportado):**

1. Secret nuevo: `MINIMAX_API_KEY` (key de [platform.minimax.io](https://platform.minimax.io)).
2. Variables del environment: `LLM_PROVIDER=minimax`, `LLM_MODEL=MiniMax-M2`.
3. Relanza el workflow (o push a `main`). Para volver a Claude, borra/cambia las variables.

**Agregar otro proveedor** (OpenAI, Google, DeepSeek/Kimi vía openai-compatible): un case nuevo en `src/lib/ai/llm.ts` siguiendo el patrón de `minimax`, su secret en GitHub y su línea en el workflow. La lógica de negocio no cambia: el schema zod valida la salida venga de donde venga.

> 💰 Referencia de costos para el volumen de este bot (~100K tokens entrada + 30K salida/mes): Claude Haiku 4.5 ≈ Q2/mes; MiniMax M2 ≈ Q0.50/mes. Transcribe (voz) cuesta más que cualquiera de los dos.

## Desarrollo local

```bash
pnpm install
pnpm typecheck        # TypeScript estricto
pnpm test             # vitest (lógica pura: fechas, comandos, agregados, schema, formato)
pnpm synth            # sintetiza la infraestructura sin deployar
ANTHROPIC_API_KEY=sk-... pnpm tsx scripts/eval-agent.ts   # eval GOLDEN del agente contra el modelo real
```

El eval golden (`scripts/eval-agent.ts`) contiene casos reales salidos de conversaciones de producción — incluidos los que alguna vez fallaron — y valida qué herramientas llama el agente. Córrelo antes de deployar cambios de prompts o herramientas.

Deploy manual de emergencia (mismo efecto que el workflow):

```bash
cp .env.example .env  # llénalo
# carga el .env al entorno (ver comentario dentro del archivo) y luego:
pnpm deploy
pnpm set-webhook
```

## Estructura

```
bin/, lib/           # CDK: app, FinanzasStack (tabla, lambdas, HTTP API, schedules, alarmas, budget), GithubOidcStack
src/handlers/        # webhook (fino), processor (toda la lógica, async), reminder, monthly-report
src/lib/processing.ts# ruteo y orquestación del bot: agente, fotos, comandos, correcciones, memoria
src/lib/ai/          # AI SDK: factory de modelos, agente con herramientas, schema zod, prompts, parseo/visión
src/lib/stt/         # puerto de transcripción + adapter Transcribe streaming
src/lib/             # dynamo, telegram, fechas GT, formato, comandos, saldos, recurrentes, proyección, guardián
test/                # vitest de la lógica pura
scripts/             # set-webhook.mjs, eval-agent.ts (eval golden), ingest.ts (ingesta de estados de cuenta)
.github/workflows/   # deploy.yml (CI + deploy con OIDC)
```

## Categorías dinámicas (base de conocimientos) 🏷️

Las categorías **no son un catálogo fijo**: viven en DynamoDB como items `CAT#<nombre>`.

- La primera vez se siembran las 17 categorías base.
- En **cada parseo** el LLM recibe el catálogo vigente con la regla: usa una existente si razonablemente aplica; **solo si ninguna encaja, crea una nueva** (slug en minúsculas sin tildes, con su emoji) y la declara en el resultado estructurado.
- El código normaliza (anti-duplicados: "Construcción" → `construccion` existente) y persiste la nueva categoría — queda disponible para siempre y el bot avisa: `🆕 Nueva categoría creada: 🐕 mascotas`.
- `/categorias` muestra el catálogo completo, marcando las que el bot creó solo.

## Modelo de datos (DynamoDB single-table `finanzas-personales`)

| Item | PK | SK | Atributos |
|---|---|---|---|
| Movimiento | `USER#allan` | `TXN#<yyyy-mm-dd>#<ulid>` | amount, type, category, method, description, rawMessage, shortId, emoji, createdAt |
| Cuenta (saldos) | `USER#allan` | `ACC#<id>` | name, emoji, seedBalance, asOf, estimated — el saldo actual se calcula en lectura: semilla + deltas de movimientos posteriores a asOf (sin drift) |
| Categoría | `USER#allan` | `CAT#<nombre>` | name, emoji, source (`seed`/`auto`), createdAt |
| Estado del día | `USER#allan` | `DAY#<fecha>` | reported, lastShortId (contador atómico de shortIds) |
| Recurrente | `USER#allan` | `REC#<slug>` | descripción, categoría, tipo (gasto/ingreso), montoTipico, diaTipico, estado (candidato/confirmado/rechazado) |
| Meta de gasto | `USER#allan` | `BUD#<categoria>` | monthlyLimit (tope mensual), source (auto/user) — el avance se calcula en lectura contra el mes |
| Hecho aprendido | `USER#allan` | `FACT#<id>` | texto que el usuario le enseñó al agente ("mi salario cae el 15 y el 29") |
| Conversación | `USER#allan` | `CONV#main` | últimos 12 intercambios (memoria de corto plazo del agente), ttl 72h |
| Dedupe de updates | `USER#allan` | `UPDATE#<update_id>` | ttl (48h) |

Consultas por prefijo de SK (`begins_with(SK, "TXN#2026-07")`) — sin GSI. La tabla tiene **PITR** habilitado (backup continuo, 35 días).

## Guardas de costos 💸

El stack incluye un presupuesto mensual de **$10 USD** sobre toda la cuenta (AWS Budgets):

| Umbral | Acción |
|---|---|
| $5 (50%) | Correo de aviso |
| $8 (80%) | Correo de alerta temprana |
| $10 (100%) | Correo + **kill switch automático**: se adjunta una política DENY-all a los roles de las 4 Lambdas y el bot deja de operar |

- El correo de alertas es `asanchezrixtun@gmail.com` (cambiable con la variable `BILLING_ALERT_EMAIL` del environment).
- ⚠️ La facturación de AWS se actualiza con **horas de retraso** — el corte no es en tiempo real. A la escala de este stack el exceso posible es de centavos, pero AWS no ofrece un tope duro instantáneo.
- El gasto de la **API de Anthropic no pasa por AWS**: su tope natural es el crédito prepagado que cargaste en console.anthropic.com (al agotarse, simplemente deja de responder).

**Para re-armar el bot después del kill switch** (nuevo ciclo de facturación o falsa alarma):
1. IAM → Roles → busca los 4 roles `FinanzasStack-*Fn*` → pestaña Permissions → **detach** de la política `KillSwitchPolicy`.
2. Billing → Budgets → `finanzas-web-mensual` → Actions → **Reset** la acción para que quede armada de nuevo.

## Alarmas de errores 🔔

Cada Lambda tiene una alarma de CloudWatch (`Errors ≥ 1` en 5 minutos) que publica a un tópico SNS con suscripción de correo (`BILLING_ALERT_EMAIL`). Si el bot falla en silencio — un update que explota, un schedule que no corre — te llega un correo con el nombre de la función. **La primera vez, SNS envía un correo "Confirm subscription" que hay que aceptar** para empezar a recibir alertas.

## Notas de seguridad

- Webhook protegido con `X-Telegram-Bot-Api-Secret-Token`; cualquier `chat_id` distinto al tuyo se ignora.
- Updates idempotentes por `update_id` (Telegram reintenta).
- IAM mínimo por Lambda; AWS desde GitHub vía OIDC (cero credenciales de larga vida).
- Los secretos viven en el environment `production` de GitHub. No commitees `.env`.
