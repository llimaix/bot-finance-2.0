# PLAN DE MEJORAS: DE V1.0.0 A V2

| Dato | Valor |
|---|---|
| Fecha | 2026-11-22 |
| Punto de partida | `v1.0.0`: funcionalidad del bot original, desplegada en infraestructura propia (`docs/funcionalidad-fork.md`) |
| Diseño de referencia | `docs/diseno-cuentas-dinamicas.md` (las secciones citadas abajo son de ese documento) |
| Seguimiento | `docs/estado-y-pendientes.md` |

---

## 1. OBJETIVO

Pasar de un bot pensado para las cuentas y el calendario de Allan a uno que se adapta a cualquier conjunto de cuentas, tarjetas e ingresos, configurado por chat, con avisos de tarjetas y una vista clara de cuánto dinero queda libre.

---

## 2. PRINCIPIOS

1. **El chat es la única vía de escritura; la Mini App solo lee** (sección 9).
2. **Datos personales fuera del repositorio**, que es público. Cuentas, terminaciones, límites, tasas, salario y nombre viven solo en DynamoDB.
3. **El código valida; el modelo propone.** Las invariantes (sección 3.1) se comprueban en código. El LLM nunca guarda configuración sin una confirmación por botones.
4. **Montos en centavos enteros**; tasas en puntos básicos enteros.
5. **Cada PR deja el bot funcionando.** Un merge a `main` despliega automáticamente, así que ningún PR puede dejar el bot a medias.
6. **Cada cambio con sus tests**, empezando por los casos mínimos de la sección 10.2.

---

## 3. FORMA DE TRABAJO

| Aspecto | Regla |
|---|---|
| Rama principal | `main`, protegida con un ruleset: PR obligatorio, CI en verde, sin force push ni borrado |
| Ramas de trabajo | Una por cambio, cortas: `feat/`, `fix/`, `chore/`, `docs/` |
| Integración | PR hacia `main` con el CI en verde (`backend`: typecheck, test y build; `terraform`: fmt, validate y tflint). Merge con *squash* |
| Despliegue | Automático al hacer merge: `terraform` (plan, aprobación y apply por root) y `lambdas` (solo las funciones afectadas) |
| Commits | Conventional Commits en una línea, firmados |
| Versiones | Semver con tag firmado y GitHub Release, cuyo título es solo la versión (`v2.0.0`) |

**Cambio grande sin romper el bot: interruptor del modelo de cuentas.** Las fases 2 a 4 cambian el modelo de datos (de `type` + `method` a `origen`/`destino`). Para que cada PR siga siendo desplegable, el modelo nuevo se construye **en paralelo**, detrás de una variable `ACCOUNTS_MODEL` (`v1` o `v2`) en los roots de Lambda. Mientras vale `v1`, el bot funciona como hoy. Se cambia a `v2` en el PR de cierre de la fase 4, que es el que se publica como `v2.0.0`.

---

## 4. FASES

| Fase | Versión | Alcance | Depende de | Tamaño |
|---|---|---|---|---|
| 0 | `v1.1.0` | Base de trabajo y deudas menores | — | S |
| 1 | `v1.2.0` | Perfil del usuario y motor de flujos guiados | 0 | M |
| 2 | — | Cuentas dinámicas y entidades bancarias (con el interruptor en `v1`) | 1 | L |
| 3 | — | Reconocimiento de la cuenta: terminación (texto e imágenes) y alias | 2 | M |
| 4 | **`v2.0.0`** | Ciclos de tarjeta e intereses; se activa el modelo `v2` | 3 | L |
| 5 | `v2.1.0` | Ingresos esperados, recurrentes declarados y cifras de "libre" | 4 | M |
| 6 | `v2.2.0` | Avisos de presupuesto y foto diaria `SNAP#` | 5 | S |
| 7 | `v2.3.0` | Dashboard en Telegram Mini App (solo lectura) | 6 | L |

Tamaño: S, unos pocos PR pequeños; M, varios PR o uno mediano; L, varios PR con cambio de modelo o de infraestructura.

---

## 5. DETALLE POR FASE

### Fase 0: base de trabajo (`v1.1.0`)

**Objetivo:** dejar el repositorio y el bot listos para trabajar por PR, y cerrar los hallazgos menores que siguen abiertos.

| PR | Cambio |
|---|---|
| `chore/` | Ruleset de `main` (PR obligatorio, CI en verde, solo *squash*, sin force push ni borrado) y borrado de las ramas `chore/fork-original` (la conserva el tag `v1.0.0`) y `chore/integrar-fork` |
| `docs/` | README nuevo: estructura, bootstrap, pipelines, secretos y cómo re-armar el bot tras el kill switch |
| `fix/` | Menú de comandos sincronizado: `set-webhook.mjs` usa `BOT_COMMANDS`, así que aparecen `/metas` y `/costo` |
| `fix/` | Escrituras que pueden pisarse: `appendConversation` con `list_append` y `putFact` con condición (análisis, tabla de hallazgos bajos) |
| `fix/` | Robustez de `secrets.ts`: `trim()` de los valores y diagnóstico de `allowed_chat_id` sin mostrar el valor |

**Criterios de aceptación:** el CI corre en cada PR y el merge despliega; el menú de Telegram muestra los 15 comandos; dos mensajes simultáneos no pierden historial.

### Fase 1: perfil y flujos guiados (`v1.2.0`)

**Objetivo:** que el bot llame al usuario por su nombre y tenga el motor de flujos guiados que usarán las fases siguientes. No cambia el modelo de cuentas.

| PR | Cambio |
|---|---|
| `feat/` | Perfil `CFG#perfil`: `/nombre`, herramienta `configurar_perfil` y prompts construidos en cada mensaje. Sin perfil, trato neutro (sección 8) |
| `feat/` | `PK` desde `ALLOWED_CHAT_ID` en lugar de `USER#allan`; los datos de prueba se reinician (sección 7 de este plan) |
| `feat/` | Motor de flujos guiados: estado en `FLOW#<id>` con TTL de 24 h, pasos con botones y tarjeta de confirmación ✅ / ✏️ / ❌ (sección 9) |
| `feat/` | Primer flujo: alta del perfil, que sirve de prueba del motor |

**Criterios de aceptación:** "llámame Luis" cambia el nombre en el siguiente mensaje sin redesplegar; un flujo interrumpido continúa en el mismo paso dentro de 24 h; ningún texto del bot dice "Allan".

### Fase 2: cuentas dinámicas y entidades (modelo `v2` en paralelo)

**Objetivo:** cuentas, tarjetas y entidades como datos, con partida doble y centavos. El interruptor sigue en `v1`.

| PR | Cambio |
|---|---|
| `feat/` | Tipos, esquemas e invariantes de `Cuenta`, `EntidadBancaria` y `Movimiento` con `origen`/`destino` en centavos (secciones 2, 3 y 3.1) |
| `feat/` | Repositorio DynamoDB de `ACC#` y `BNK#`, y cálculo de saldo por partida doble |
| `feat/` | Herramientas `crear_cuenta`, `editar_cuenta` y `gestionar_entidad`, que proponen y piden confirmación |
| `feat/` | Flujo guiado de alta de entidades, cuentas y tarjetas (con tasa de interés opcional), y comando `/cuentas` con edición por botones |

**Criterios de aceptación:** casos de la sección 10.2 sobre partida doble, pago de tarjeta, alias únicos y centavos.

### Fase 3: reconocimiento de la cuenta

**Objetivo:** que el bot sepa con qué cuenta se pagó sin preguntarlo cuando el texto o la imagen lo dicen.

| PR | Cambio |
|---|---|
| `feat/` | Resolución por terminación en texto, solo con contexto explícito (sección 4) |
| `feat/` | Alias de cuenta y de entidad con normalización (sección 3.2); sustituye `ACCOUNT_SIGNALS` y "BI = débito" |
| `feat/` | Visión: campo `terminacion` desde vouchers, capturas de wallet, app y notificaciones; aprendizaje de terminaciones nuevas tras confirmar (sección 4.1) |
| `feat/` | `registrar_movimientos` con `origen`/`destino` y esquema `z.enum` dinámico con las cuentas existentes |

**Criterios de aceptación:** casos de la sección 10.2 sobre terminación, alias y capturas, incluidos los negativos (montos de 4 dígitos, números de autorización).

### Fase 4: ciclos de tarjeta e intereses, y activación (`v2.0.0`)

**Objetivo:** tarjetas con corte, pago, avisos e interés estimado, y paso definitivo al modelo nuevo.

| PR | Cambio |
|---|---|
| `feat/` | Cálculo del ciclo y `CYC#` escrito por el guardián (secciones 5.1 y 5.2) |
| `feat/` | Avisos de corte, pago, vencimiento, uso del límite e interés estimado en el guardián (secciones 5.3 y 5.4) |
| `feat/` | `registrar_estado_cuenta` con saldo al corte, pago mínimo e intereses cobrados; `/tarjetas` |
| `feat/` | Comandos y reportes existentes (`/saldo`, `/hoy`, `/mes`, `/reporte`, `/export`) leyendo el modelo nuevo |
| `feat/` | **Activación:** `ACCOUNTS_MODEL = v2`, reinicio de los datos de prueba, alta guiada completa y retirada del código del modelo `v1` |

**Criterios de aceptación:** casos de la sección 10.2 sobre cortes (31 en febrero, `diaPago` menor que `diaCorte`), pago parcial e intereses; todos los comandos funcionan con el modelo nuevo.

### Fase 5: ingresos, recurrentes y "libre" (`v2.1.0`)

| PR | Cambio |
|---|---|
| `feat/` | Ingresos esperados `INC#` con conciliación de ±3 días y ±10 % (sección 6) |
| `feat/` | Plan de quincena con los días de `INC#`, sustituyendo el calendario fijo de `dates.ts` |
| `feat/` | Recurrentes declarados: `REC#` con `origen` aprendido o declarado, y herramienta `declarar_recurrente` (sección 9) |
| `feat/` | Cifras de "libre" y comando `/libre` (sección 7) |

### Fase 6: avisos de presupuesto y foto diaria (`v2.2.0`)

| PR | Cambio |
|---|---|
| `feat/` | Avisos de meta al registrar (`budgetProgress` en `warningsFor`) y tope global mensual opcional |
| `feat/` | Foto diaria `SNAP#` escrita por el guardián, base de la gráfica de "libre" |

### Fase 7: dashboard en Telegram Mini App (`v2.3.0`)

| PR | Cambio |
|---|---|
| `chore/` | Permisos de infraestructura nuevos en la plantilla de bootstrap: S3 y CloudFront para el sitio estático (requiere actualizar el stack a mano) |
| `feat/` | Roots de Terraform: bucket del sitio, CloudFront y Lambda de API **de solo lectura** con su ruta |
| `feat/` | Validación de `initData` firmado por Telegram y de `ALLOWED_CHAT_ID` (análisis, sección 8) |
| `feat/` | Gráficas: deuda por tarjeta al corte frente al límite, participación por categoría y línea de "libre" con proyección |
| `feat/` | Pipeline del frontend y botón "Ver dashboard" en el bot |

---

## 6. CAMBIOS DE INFRAESTRUCTURA PREVISTOS

| Fase | Cambio | ¿Requiere actualizar el bootstrap a mano? |
|---|---|---|
| 0 | Ninguno (solo configuración del repositorio) | No |
| 1–6 | Variables nuevas en los roots de Lambda (`ACCOUNTS_MODEL`); sin recursos nuevos | No |
| 7 | Bucket S3, CloudFront y una Lambda nueva | **Sí**: el rol del pipeline no tiene permisos de S3 (salvo el state) ni de CloudFront |

---

## 7. DECISIONES

| Decisión | Resolución (2026-11-22) |
|---|---|
| Datos registrados durante `v1` | **Se reinician.** Hoy solo hay datos de prueba: no hace falta el script de migración de la sección 10.1 del diseño |
| Cambio de `PK` en la fase 1 | **Se reinicia**, igual que el punto anterior: los items de `USER#allan` se borran y se empieza en `USER#<chatId>` |
| Eval golden del agente (`backend/scripts/eval-agent.ts`) | **No por ahora.** Hoy no corre en ningún pipeline. Sus 16 casos son de las cuentas de Allan y caducan con el modelo `v2`. En la fase 3 se escriben casos nuevos y se ejecutan con un workflow manual; volverlo bloqueante se valora después |
| Plan de Terraform en los PR | **No.** El plan y el apply se quedan en el merge a `main`, con aprobación; el CI de los PR valida sin credenciales |

Mientras la fase 1 no esté desplegada, el bot sigue en `v1` y lo que se registre se considera de prueba.

---

## 8. FUERA DE ALCANCE

- Compras a cuotas y sus intereses (diseño, 11.2).
- Saldos en dólares en las tarjetas: una moneda por cuenta.
- Multiusuario: el bot es solo para Luis.
- Edición de datos desde la Mini App.
