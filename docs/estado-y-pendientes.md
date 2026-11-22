# ESTADO Y PENDIENTES

Última actualización: 2026-11-22.

---

## 1. DÓNDE NOS QUEDAMOS

| Paso | Estado |
|---|---|
| Análisis técnico y funcional del bot original | ✅ Hecho (`docs/analisis-bot-finance.md`) |
| Diagramas de arquitectura actual, propuesta y modelo de cuentas | ✅ Hecho (`docs/diagramas/`). El modelo de cuentas (`03`) quedó atrás del diseño (sección 12 del diseño) |
| Diseño del modelo de cuentas dinámicas | ✅ Actualizado el 2026-11-22 con intereses, alias por entidad, terminación desde imágenes, nombre dinámico y el principio "chat para escribir, Mini App para leer" |
| Importación del código a este repo | ✅ Commit `5bef575` en `main` (era `ccf85c1`; se reescribió para quitar la atribución) |
| Fork del original desplegado | ✅ Rama `chore/fork-original`: misma funcionalidad que el original, desplegada en AWS por pipelines (Terraform por roots, Lambdas por matriz, webhook manual) y con H1, H2, M1–M7 resueltos. Detalle en `docs/funcionalidad-fork.md` de esa rama |
| Próxima tarea | ⏳ Versión 2.0: decidir la rama base (recomendado: partir de `chore/fork-original`, que ya tiene la infraestructura y las correcciones) y dónde se despliega |

---

## 2. DECISIONES TOMADAS

| Fecha | Decisión |
|---|---|
| 2026-11-21 | El bot es **solo para Luis** (sin multiusuario). Autenticación: `ALLOWED_CHAT_ID` |
| 2026-11-21 | **Sin saldo en dólares** en las tarjetas: una moneda (GTQ) por cuenta |
| 2026-11-21 | **Sin compras a cuotas**: cada compra entra completa en su ciclo |
| 2026-11-21 | Modelo de **partida doble simplificada** (`origen`/`destino`) en lugar de `type` + `method` |
| 2026-11-21 | Montos en **centavos enteros** |
| 2026-11-21 | Dashboard web como **Telegram Mini App** (opción A del análisis, sección 8) |
| 2026-11-21 | Importación como copia limpia, directo en `main` |
| 2026-11-21 | Fork del original en `chore/fork-original` con el historial de Allan: solo cambian estructura y despliegue |
| 2026-11-21 | **Todo se despliega por pipelines**; la única excepción es la plantilla de bootstrap de CloudFormation (bucket del state, rol OIDC y boundary), que se carga a mano |
| 2026-11-21 | Infraestructura en **Terraform con submódulos y un root por componente** (cada Lambda con su root); states en `bot-finance-tfstate` con bloqueo nativo de S3 |
| 2026-11-21 | Misma cuenta AWS que rodolfo-invite, aislada por prefijo `bot-finance-` y por el tag `Project` |
| 2026-11-21 | Secretos en Secrets Manager, cargados a mano; Terraform solo conoce sus nombres y la Lambda los lee con el SDK |
| 2026-11-22 | Proveedor de IA: **MiniMax-M3** (texto, agente y visión) |
| 2026-11-22 | **Intereses de tarjeta opcionales**: tasa por tarjeta para estimar el costo de no pagar el total (diseño, 5.4) |
| 2026-11-22 | **Alias por entidad bancaria** ("Banco Industrial" = "BI"), además de los alias por cuenta (diseño, 3.2) |
| 2026-11-22 | **Terminación desde cualquier imagen** (voucher, wallet, app, notificación), con aprendizaje de terminaciones nuevas (diseño, 4.1) |
| 2026-11-22 | **Nombre de usuario dinámico** en el perfil (`CFG#perfil`), editable sin redesplegar (diseño, 8) |
| 2026-11-22 | **Chat para escribir, Mini App para leer**: toda alta y edición por chat (flujo guiado o libre, con confirmación por botones); la Mini App es solo un reporte visual sin endpoints de escritura (diseño, 9) |
| 2026-11-22 | **Recurrentes declarados** desde el primer día, además de los aprendidos (diseño, 9) |
| 2026-11-22 | **Datos personales fuera del repositorio** (es público): el inventario de cuentas se captura en el alta guiada del bot |

---

## 3. DATOS DE LUIS

**No se escriben en este repositorio: es público.** Cuentas, terminaciones, límites, tasas, salario y nombre se capturan en el **alta guiada del bot** cuando la 2.0 esté desplegada, y viven solo en DynamoDB. Qué pide el flujo: diseño, sección 11.3.

---

## 4. PENDIENTES PRIORIZADOS

Detalle y evidencia de cada hallazgo en `docs/analisis-bot-finance.md`, sección 4.

### 4.1 Seguridad y fiabilidad (código heredado)

Resueltos en el fork (`chore/fork-original`). Si la 2.0 parte de esa rama, los hereda; si partiera de `main`, habría que volver a aplicarlos.

| ID | Pendiente | Estado en el fork |
|---|---|---|
| H1 | Secretos fuera del código y de la configuración de la Lambda | ✅ Secrets Manager, lectura por SDK con caché |
| H2 | Retención de logs y texto financiero en los logs | ✅ 30 días de retención y redacción en el logger (`f116b7c`) |
| M1 | Kill switch que no corta el costo real; budget de toda la cuenta | ✅ Budget filtrado por `Project`. MiniMax sigue fuera de AWS |
| M2 | Throttling en la API HTTP | ✅ 5/s con ráfaga de 10 |
| M3 | `corregir_movimiento` acepta montos ≤ 0 | ✅ `f68556f` |
| M4 | Posible doble registro tras el reintento del agente | ✅ `ee7f1b4` |
| M5 | Timeout del processor pierde el mensaje sin aviso | ✅ Presupuesto de tiempo y aviso antes del corte (`c88921e`), sin DLQ |
| M6 | Actions de terceros fijadas por SHA | ✅ En los pipelines nuevos |
| M7 | Revisor obligatorio antes de desplegar | ✅ En infraestructura (environment `terraform-apply`); el código se despliega con tests como puerta |
| Bajos | Menú de comandos desincronizado (faltan `/metas` y `/costo`), escrituras que se pisan, eval no bloqueante | ⏳ Pendientes |

### 4.2 Personalización (de "Allan" a "Luis")

- `PK` desde configuración en lugar de `USER#allan` (`src/lib/dynamo.ts:30`).
- Nombre del usuario **dinámico** en el perfil (`CFG#perfil`), editable con `/nombre` o en lenguaje natural; hoy "Allan" aparece en 7 archivos de `src/` (diseño, sección 8).
- ~~Correo de alertas por defecto de Allan~~: resuelto en el fork con el secret `ALERT_EMAIL`.
- Calendario de pago fijo (`src/lib/dates.ts:71-106`): lo sustituye `INC#` del diseño.
- Cuentas fijas (`src/lib/accounts.ts:4`, `src/lib/types.ts:80`) y señales "BI = débito" (`src/lib/guards.ts:21-30`): las sustituye el diseño de cuentas dinámicas.

### 4.3 Funcionalidad nueva (en orden de dependencia)

1. **Perfil y alta guiada por chat**: nombre dinámico, `PK` desde configuración, motor de flujos guiados (`FLOW#`) con confirmación por botones (diseño, secciones 8 y 9). Es la base para capturar todo lo demás.
2. **Cuentas dinámicas** con partida doble y centavos, y **entidades bancarias con alias** (diseño, secciones 2–3.2).
3. **Reconocimiento de la cuenta** por terminación, en texto y en **cualquier imagen** (voucher, wallet, app, notificación), y por alias de cuenta o de entidad; las terminaciones desconocidas se aprenden (diseño, secciones 4 y 4.1).
4. **Ciclos de tarjeta** con avisos de corte y pago en el guardián, e **intereses opcionales** con estimación y cargo real del estado de cuenta (diseño, sección 5).
5. **Ingresos esperados** configurables y conciliación, y **recurrentes declarados** (diseño, secciones 6 y 9).
6. **Cifras de "libre"**: disponible, deuda total, libre hasta el próximo pago, libre después del salario; comando `/libre` (diseño, sección 7).
7. **Avisos de presupuesto al registrar** (llamar a `budgetProgress` en `warningsFor`) y tope global mensual opcional.
8. **Foto diaria `SNAP#`** escrita por el guardián (base de la gráfica de "libre").
9. **Dashboard Telegram Mini App, solo lectura**: reporte visual de lo registrado por chat. Barras de deuda por tarjeta al corte vs límite, dona de participación, línea de "libre" con proyección (análisis, sección 8). Sin endpoints de escritura.

---

## 5. IDEAS PARA MÁS ADELANTE

- Exportación mensual de la tabla a S3 (respaldo más allá de los 35 días de PITR).
- Alarma de `Duration` cerca del timeout y métricas propias (activaciones de la red de seguridad, timeouts del LLM).
- Separar `src/lib/processing.ts` (1.191 líneas) en comandos, callbacks y flujo del agente, con tests de la orquestación.
- `cdk diff` informativo y `pnpm audit`/Dependabot en el pipeline.
- Si algún día se usan compras a cuotas: añadir el modelo de cuotas (hoy es limitación aceptada).
- Suscripciones en USD: mostrar la diferencia de tipo de cambio contra el estado de cuenta al corte.

---

## 6. LECCIONES DEL ENTORNO (para no repetir errores)

- **Commits:** Git firma con SSH (`commit.gpgsign=true`, llave en `~/.ssh`); el sandbox no da acceso, así que se deja el staging y el mensaje y **Luis ejecuta el commit**. No usar `--no-gpg-sign`.
- **`.env*`:** ni lectura ni `stat` desde el sandbox; `git add -A` falla si hay un `.env*` sin seguimiento (usar pathspec de exclusión, p. ej. `':!*.example'`). Los comandos que nombran `.env` pueden ser rechazados por la regla de permisos.
- **npm:** el sandbox no deja escribir en `~/.npm/_cacache`; usar `--cache` en un directorio temporal. El mensaje de npm sobre "archivos de root" es engañoso: no hace falta `sudo chown`.
- **Red:** el sandbox sale por un proxy (`HTTPS_PROXY`). `curl` y npm lo usan; el descargador de Puppeteer no.
- **Mermaid:** no hay renderizador instalado. Chrome headless no arranca dentro del sandbox (puerto Mach denegado); el render lo ejecuta Luis en su terminal. El `chrome-headless-shell` de Chrome for Testing viene con firma ad-hoc, sin notarizar. Tras usarlo, borrar la instalación temporal.
- **Escritura:** este repo debe estar añadido a la sesión de trabajo.
- **TLS en binarios Go:** `terraform` y `gh` no verifican certificados dentro del sandbox (`x509: OSStatus -26276`); `curl` y `git` sí funcionan. `terraform init/validate` y `tflint` los ejecuta Luis con `!`.
- **`process.env` en comandos:** un comando que contenga `.env` puede ser rechazado por la regla de permisos; buscar con `process\.` o leer el archivo con la herramienta de lectura.
- **OIDC de GitHub:** los repos creados después del 15-jul-2026 usan `sub` inmutable (`repo:OWNER@ID/REPO@ID:...`); la trust policy debe usar ese formato.
- **`workflow_dispatch`:** el botón "Run workflow" solo aparece si el workflow existe en la rama por defecto; por eso `main` tiene stubs de los workflows del fork.
- **Secretos en Lambda:** cada contenedor los cachea; tras cambiar un secreto, relanzar el workflow `lambdas` para que los contenedores nuevos lo lean.
- **`allowed_chat_id`:** es el `senderId` que aparece en el log `chat no permitido` del webhook, no el número que precede a los dos puntos en el token (ese es el ID del bot).
