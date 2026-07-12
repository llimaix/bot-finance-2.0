# finanzas-web 💰

Bot de Telegram para registrar finanzas personales (quetzales, GTQ) con mínima fricción: le escribes o le mandas una **nota de voz** con los movimientos del día, la IA los estructura y quedan guardados en DynamoDB. Incluye recordatorios diarios, comandos de consulta y un reporte mensual con análisis.

## Arquitectura

```
Telegram ──webhook──▶ API Gateway (HTTP API) ──▶ Lambda webhook ──▶ DynamoDB (single-table)
                                                    │  ├─ AI SDK (LLM_PROVIDER) → parseo/corrección/narrativa
                                                    │  └─ STT (STT_PROVIDER)    → transcripción de voz
EventBridge Scheduler (hora de Guatemala)
  ├─ 08:30 diario     ──▶ Lambda reminder (guardián: solo habla si hay hallazgos —
  │                        saldos negativos, recurrentes vencidos, proyección en rojo)
  ├─ 17:00 diario     ──▶ Lambda reminder (recordatorio)
  ├─ 21:00 diario     ──▶ Lambda reminder (seguimiento solo si no respondiste)
  ├─ 20:00 domingo    ──▶ Lambda reminder (resumen semanal)
  └─ 08:00 día 1      ──▶ Lambda monthly-report (reporte del mes cerrado)
```

- **Stack**: Node.js 24 + TypeScript, AWS CDK v2, pnpm, Vitest.
- **IA agnóstica de proveedor**: [Vercel AI SDK](https://ai-sdk.dev). Hoy usa Claude (`claude-haiku-4-5`); cambiar a OpenAI/MiniMax/Google es instalar el provider y cambiar env vars (ver abajo).
- **Voz**: Amazon Transcribe **streaming** (`ogg-opus` directo, español `es-US`) — sin S3, detrás de un puerto intercambiable (`src/lib/stt/`).
- **Deploy**: automático con GitHub Actions en cada push a `main` (environment `production` + OIDC, sin access keys).
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
| `/categorias` | Ver la base de conocimientos de categorías |
| `/borrar N` | Elimina el movimiento #N de hoy (o usa el botón 🗑️ bajo cada confirmación) |
| `corrige #N ...` | Corrige un movimiento en lenguaje natural: "corrige #2 eran Q50 con débito" |

Cada confirmación trae **botones inline** `🗑️ #N` para borrar al toque, y los domingos a las 20:00 llega un **resumen semanal** automático.

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
```

Deploy manual de emergencia (mismo efecto que el workflow):

```bash
cp .env.example .env  # llénalo
# carga el .env al entorno (ver comentario dentro del archivo) y luego:
pnpm deploy
pnpm set-webhook
```

## Estructura

```
bin/, lib/           # CDK: app, FinanzasStack (tabla, lambdas, HTTP API, schedules), GithubOidcStack
src/handlers/        # webhook, reminder, monthly-report
src/lib/ai/          # AI SDK: factory de modelo, schema zod, prompts, parseo/corrección/narrativa
src/lib/stt/         # puerto de transcripción + adapter Transcribe streaming
src/lib/             # dynamo, telegram, fechas GT, formato, comandos, agregados, reporte
test/                # vitest de la lógica pura
scripts/             # set-webhook.mjs (lo corre el workflow en cada deploy)
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
| Dedupe de updates | `USER#allan` | `UPDATE#<update_id>` | ttl (48h) |

Consultas por prefijo de SK (`begins_with(SK, "TXN#2026-07")`) — sin GSI.

## Guardas de costos 💸

El stack incluye un presupuesto mensual de **$10 USD** sobre toda la cuenta (AWS Budgets):

| Umbral | Acción |
|---|---|
| $5 (50%) | Correo de aviso |
| $8 (80%) | Correo de alerta temprana |
| $10 (100%) | Correo + **kill switch automático**: se adjunta una política DENY-all a los roles de las 3 Lambdas y el bot deja de operar |

- El correo de alertas es `asanchezrixtun@gmail.com` (cambiable con la variable `BILLING_ALERT_EMAIL` del environment).
- ⚠️ La facturación de AWS se actualiza con **horas de retraso** — el corte no es en tiempo real. A la escala de este stack el exceso posible es de centavos, pero AWS no ofrece un tope duro instantáneo.
- El gasto de la **API de Anthropic no pasa por AWS**: su tope natural es el crédito prepagado que cargaste en console.anthropic.com (al agotarse, simplemente deja de responder).

**Para re-armar el bot después del kill switch** (nuevo ciclo de facturación o falsa alarma):
1. IAM → Roles → busca los 3 roles `FinanzasStack-*Fn*` → pestaña Permissions → **detach** de la política `KillSwitchPolicy`.
2. Billing → Budgets → `finanzas-web-mensual` → Actions → **Reset** la acción para que quede armada de nuevo.

## Notas de seguridad

- Webhook protegido con `X-Telegram-Bot-Api-Secret-Token`; cualquier `chat_id` distinto al tuyo se ignora.
- Updates idempotentes por `update_id` (Telegram reintenta).
- IAM mínimo por Lambda; AWS desde GitHub vía OIDC (cero credenciales de larga vida).
- Los secretos viven en el environment `production` de GitHub. No commitees `.env`.
