# bot-finance

Bot de Telegram para registrar finanzas personales en quetzales (GTQ). Se le escribe, se le manda una nota de voz o una foto del comprobante, y la IA estructura los movimientos y los guarda en DynamoDB. Incluye consultas, asesoría, recordatorios, un guardián diario y un reporte mensual.

Serverless en AWS (Lambda arm64, DynamoDB, API Gateway HTTP, EventBridge Scheduler), con la infraestructura en Terraform y el despliegue solo por GitHub Actions.

Basado en [`Allan-Sanchez/bot-finance`](https://github.com/Allan-Sanchez/bot-finance), con autorización de su autor.

| Versión | Estado |
|---|---|
| `v1.0.0` | Funcionalidad del bot original en infraestructura propia, con correcciones de seguridad y fiabilidad (`docs/funcionalidad-fork.md`) |
| `v2` | En desarrollo: cuentas dinámicas, tarjetas con ciclos, alta por chat y dashboard (`docs/plan-mejoras-v2.md`) |

---

## Arquitectura

```
Telegram ──webhook──▶ API Gateway HTTP (POST /webhook, throttling 5/s)
                          │
                          ▼
                      Lambda webhook (10 s): valida el secret token y el chat
                          │ invocación asíncrona
                          ▼
                      Lambda processor (180 s) ──▶ DynamoDB (single-table, PITR)
                          ├─ Agente con herramientas (MiniMax-M3)
                          ├─ Visión de comprobantes (MiniMax-M3)
                          └─ Voz (Amazon Transcribe streaming)

EventBridge Scheduler (hora de Guatemala)
  ├─ 08:00 diario       ──▶ Lambda reminder: plan de quincena (solo en víspera de pago)
  ├─ 08:30 diario       ──▶ Lambda reminder: guardián (solo si hay hallazgos)
  ├─ 17:00 diario       ──▶ Lambda reminder: recordatorio
  ├─ 21:00 diario       ──▶ Lambda reminder: seguimiento si no hubo respuesta
  ├─ 20:00 domingo      ──▶ Lambda reminder: resumen semanal con coach
  └─ 08:00 día 1        ──▶ Lambda monthly-report: reporte del mes cerrado

Secrets Manager ──▶ secretos leídos por las Lambdas en tiempo de ejecución
CloudWatch      ──▶ alarma de errores por Lambda ──▶ SNS ──▶ correo
AWS Budgets     ──▶ $10/mes del gasto con tag Project ──▶ kill switch
```

---

## Estructura

```
backend/                 Código de las Lambdas (Node.js 24, TypeScript, pnpm, Vitest)
  src/handlers/          webhook, processor, reminder, monthly-report
  src/lib/               lógica del bot: agente, parseo, DynamoDB, Telegram, secretos, logger
  test/                  tests de la lógica pura
  scripts/               build.mjs (esbuild + metafile), set-webhook.mjs, eval-agent.ts
infra/                   Terraform
  modules/               submódulos reutilizables (lambda-function, http-api, lambda-schedules, ...)
  live/<root>/           un root por componente, cada uno con su state
bootstrap/cloudformation Plantilla única: bucket del state, rol OIDC y permissions boundary
docs/                    análisis, diseño 2.0, plan de mejoras y estado
.github/workflows/       ci, terraform, lambdas, telegram-webhook
```

Roots de Terraform, en orden de aplicación: `dynamodb`, `secrets`, `lambda-app-processor`, `lambda-app-webhook`, `lambda-app-reminder`, `lambda-app-monthly-report`, `api-gateway`, `scheduler`, `observability`, `budget`.

---

## Qué hace el bot

| Uso | Ejemplo |
|---|---|
| Registrar por texto o voz | "almuerzo Q45 en efectivo y Q200 de gasolina con la de crédito" |
| Registrar por foto | Foto del comprobante; el pie de foto da contexto ("con la de crédito") |
| Fechas pasadas | "ayer gasté…", "el lunes pagué…" |
| Pagos en USD | Se convierten a quetzales con `USD_GTQ_RATE` (7,80 por defecto) |
| Corregir o borrar | "corrige #2, eran Q50"; botón 🗑️ o `/borrar N` |
| Preguntar | "¿cuánto gasté en farmacia en mayo?", "¿me alcanza para…?" |
| Enseñarle algo | "mi salario cae el 15 y el 29" (se ve en `/memoria`) |

**Comandos:** `/hoy`, `/semana`, `/mes`, `/reporte`, `/nada`, `/categorias`, `/saldo`, `/proyeccion`, `/metas`, `/costo`, `/recurrentes`, `/memoria`, `/export`, `/borrar`, `/nombre`, `/cuentas`, `/tarjetas`, `/libre`, `/ayuda`.

Detalle completo y diferencias con el original: `docs/funcionalidad-fork.md`.

---

## Puesta en marcha (una sola vez)

### 1. Bootstrap en AWS

Requisito: el proveedor OIDC de GitHub (`token.actions.githubusercontent.com`) debe existir en la cuenta. Es uno por cuenta y la plantilla lo reutiliza.

1. En la consola de CloudFormation, crear el stack `bot-finance-bootstrap` subiendo `bootstrap/cloudformation/template.yml`.
2. Revisar los parámetros. `GitHubOwnerId` y `GitHubRepoId` son los IDs numéricos del repositorio: los repos creados después del 15-jul-2026 usan el `sub` inmutable de OIDC (`repo:OWNER@ID/REPO@ID:...`).
3. Aceptar la creación de recursos IAM con nombre propio.
4. Copiar el output `GitHubActionsRoleArn`.

Crea el bucket del state (`bot-finance-tfstate`), el rol `github-actions-bot-finance`, que solo puede asumir la rama `main` de este repo, y el boundary `boundary-bot-finance`, obligatorio en todos los roles que crea Terraform.

El parámetro `HostedZoneId` es el ID de la hosted zone pública que contiene el dominio de la Mini App (sin `/hostedzone/`). La pila también crea la managed policy `bot-finance-github-miniapp` (S3, CloudFront, ACM y Route 53 de la Mini App).

El bucket tiene `Retain`, y el rol y el boundary `RetainExceptOnCreate`: borrar la pila no los elimina (el boundary, además, no se puede borrar mientras lo usen los roles de las Lambdas). Para recrear la pila cuando el bucket y el boundary ya existen:

1. Crear la pila con `ManageStateResources=false`: crea el rol y las políticas, sin el bucket ni el boundary.
2. Importarlos con un change set `IMPORT` y `ManageStateResources=true` (una importación no puede crear recursos, solo adoptar):

```
aws cloudformation create-change-set --stack-name bot-finance-bootstrap --change-set-name adoptar \
  --change-set-type IMPORT --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://bootstrap/cloudformation/template.yml \
  --parameters ParameterKey=HostedZoneId,UsePreviousValue=true ParameterKey=ManageStateResources,ParameterValue=true \
  --resources-to-import '[{"ResourceType":"AWS::S3::Bucket","LogicalResourceId":"TfStateBucket","ResourceIdentifier":{"BucketName":"bot-finance-tfstate"}},{"ResourceType":"AWS::IAM::ManagedPolicy","LogicalResourceId":"WorkloadBoundary","ResourceIdentifier":{"PolicyArn":"arn:aws:iam::<cuenta>:policy/boundary-bot-finance"}}]'
```

### 2. GitHub

| Dónde | Qué |
|---|---|
| *Settings → Secrets and variables → Actions* | `AWS_ROLE_ARN`: el output del paso anterior. `ALERT_EMAIL`: correo para alarmas y budget |
| *Settings → Environments* | `terraform-apply` con revisor obligatorio y rama de despliegue `main`: es la aprobación antes de cada apply |
| *Settings → Rules* | Ruleset en `main`: PR obligatorio, checks `backend` y `terraform`, solo squash, commits firmados, sin force push ni borrado |

### 3. Infraestructura y código

Un push a `main` con cambios en `infra/` o `backend/` dispara los pipelines. La primera vez se crean todos los roots. Después hay que cargar los secretos y registrar el webhook.

### 4. Secretos de la aplicación

Terraform crea los secretos **vacíos**. Los valores se cargan a mano en *Secrets Manager → Retrieve secret value → Set secret value*, en la pestaña *Key/value*:

| Secreto | Claves |
|---|---|
| `bot-finance/telegram` | `bot_token`, `webhook_secret`, `allowed_chat_id` |
| `bot-finance/llm` | `minimax_api_key` (y `anthropic_api_key` si se usa ese proveedor) |

- `bot_token`: con [@BotFather](https://t.me/BotFather) → `/newbot`.
- `webhook_secret`: inventado, solo `A-Za-z0-9_-` (por ejemplo, `openssl rand -hex 32`).
- `allowed_chat_id`: el chat que puede usar el bot. Si no se conoce, se escribe al bot con un valor provisional y se toma el `senderId` del log `chat no permitido` de la Lambda webhook. **No** es el número que precede a los dos puntos en el token: ese es el ID del bot.
- `minimax_api_key`: en [platform.minimax.io](https://platform.minimax.io), con saldo de pago por uso.

### 5. Registrar el webhook

*Actions → telegram-webhook → Run workflow*. Registra la URL de la API con el secret token y el menú de comandos, y muestra lo que Telegram tiene registrado.

---

## Pipelines

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `ci` | PR hacia `main` | Sin credenciales de AWS: typecheck, tests y build del backend; `fmt`, `validate` y `tflint` de Terraform |
| `terraform` | Push a `main` con cambios en `infra/`, o manual | Detecta los roots afectados (también por cambios en sus módulos), planea en orden y, si hay cambios, pide aprobación en el environment `terraform-apply` y aplica los planes aprobados |
| `lambdas` | Push a `main` con cambios en `backend/`, o manual | Typecheck, tests y build; cruza los cambios con el metafile de esbuild y despliega solo las funciones afectadas (matriz, una por job) |
| `telegram-webhook` | Manual | Registra el webhook y el menú de comandos en Telegram |

Las acciones de terceros están fijadas por SHA. Los planes de Terraform se guardan como artefacto 1 día.

---

## Operación

| Necesidad | Cómo |
|---|---|
| Cambiar un secreto | Editarlo en Secrets Manager y relanzar `lambdas` (manual, campo vacío): cada contenedor cachea los secretos y el redespliegue fuerza a leerlos de nuevo |
| Cambiar la URL o el `webhook_secret` | Relanzar `telegram-webhook` |
| Cambiar de proveedor de IA | `llm_provider` en `terraform.tfvars` de los roots `lambda-app-*` (`minimax` o `anthropic`), por PR |
| Ver errores | Alarma por correo y CloudWatch Logs (`/aws/lambda/bot-finance-*`, retención de 30 días). Los logs no guardan texto ni montos del usuario |
| Re-armar el bot tras el kill switch | En *Billing → Budgets → `bot-finance-mensual` → Actions*, revertir la acción (retira la política `bot-finance-kill-switch` de los roles de las Lambdas) y luego restablecerla para que quede armada |

El budget solo mide el gasto en AWS con el tag `Project=bot-finance`: no incluye Transcribe (no admite tags) ni el gasto en MiniMax, cuyo tope es el saldo cargado en su plataforma.

---

## Desarrollo

```bash
cd backend
pnpm install
pnpm typecheck
pnpm test
pnpm build        # dist/<función>/index.mjs y meta.json
```

Flujo de trabajo:

1. Rama corta desde `main`: `feat/`, `fix/`, `chore/` o `docs/`.
2. Commits firmados en Conventional Commits, de una línea.
3. PR hacia `main` con el CI en verde; merge con squash.
4. El merge despliega. Las versiones se publican como tag firmado y GitHub Release (`vX.Y.Z`).

Los datos personales (cuentas, terminaciones, montos, nombres) nunca van al repositorio, que es público.

---

## Documentación

| Documento | Contenido |
|---|---|
| `docs/funcionalidad-fork.md` | Funcionalidad de `v1.0.0` frente al original y mejoras aplicadas |
| `docs/plan-mejoras-v2.md` | Plan por fases hacia `v2` |
| `docs/diseno-cuentas-dinamicas.md` | Diseño del modelo de cuentas de `v2` |
| `docs/analisis-bot-finance.md` | Análisis técnico y funcional del bot original |
| `docs/estado-y-pendientes.md` | Estado, decisiones y pendientes |
