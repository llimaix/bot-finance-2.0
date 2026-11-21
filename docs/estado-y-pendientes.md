# ESTADO Y PENDIENTES

Última actualización: 2026-11-21.

---

## 1. DÓNDE NOS QUEDAMOS

| Paso | Estado |
|---|---|
| Análisis técnico y funcional del bot original | ✅ Hecho (`docs/analisis-bot-finance.md`) |
| Diagramas de arquitectura actual, propuesta y modelo de cuentas | ✅ Hecho (`docs/diagramas/`) |
| Diseño del modelo de cuentas dinámicas | ✅ Decisiones tomadas (`docs/diseno-cuentas-dinamicas.md`); falta el inventario de cuentas |
| Importación del código a este repo | ✅ Commit `ccf85c1`, firmado, sin push (`main` va 1 commit por delante de `origin/main`) |
| Próxima tarea | ⏳ Elegir entre: (a) cerrar el diseño con el inventario de cuentas o (b) empezar por seguridad (H1 + H2) |

**Nota menor:** el mensaje de `ccf85c1` dice que `.env.example` no se incluye, pero sí está incluido (idéntico al original, verificado por hash `e80770d`). Corregible con `--amend` antes del primer push, si se quiere.

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

---

## 3. DATOS PENDIENTES DE LUIS

Sin números completos de tarjeta; solo los últimos 4 dígitos.

| Cuenta | Banco | Tipo (débito, crédito, efectivo, billetera) | Últimos 4 | Día de corte | Día de pago | Límite |
|---|---|---|---|---|---|---|
| | | | | | | |

Salario: monto neto aproximado, días de pago y cuenta donde se deposita.

---

## 4. PENDIENTES PRIORIZADOS

Detalle y evidencia de cada hallazgo en `docs/analisis-bot-finance.md`, sección 4.

### 4.1 Seguridad y fiabilidad (código heredado)

| Prioridad | ID | Pendiente | Tamaño |
|---|---|---|---|
| 1 | H1 | Secretos a SSM Parameter Store (SecureString), leídos en tiempo de ejecución; valorar rotar credenciales si se reutilizan las de Allan (lo normal es crear bot, keys y cuenta AWS propios) | M |
| 1 | H2 | Retención de logs (1–3 meses) y dejar de loguear texto financiero completo | S |
| 2 | M3 | `corregir_movimiento` acepta montos ≤ 0 (`agent.ts:226`) | XS |
| 2 | M4 | `usedWriteTool` solo mira el reintento del agente → posible doble registro (`agent.ts:349-373`) | XS |
| 3 | M1 | Kill switch que no corta el costo real; budget de toda la cuenta | M |
| 3 | M2 | Throttling en la API HTTP | XS |
| 3 | M5 | Timeout del processor pierde el mensaje sin aviso | S |
| 4 | M6 | Actions de terceros fijadas por SHA | XS |
| 4 | M7 | Revisor obligatorio en `production`; eval bloqueante cuando sea estable | XS |
| 5 | Bajos | Menú de comandos desincronizado, escrituras que se pisan, `--require-approval never`, docs desactualizadas | XS c/u |

### 4.2 Personalización (de "Allan" a "Luis")

- `PK` desde configuración en lugar de `USER#allan` (`src/lib/dynamo.ts:30`).
- Nombre del usuario configurable en prompts y descripciones de herramientas (`src/lib/ai/prompts.ts`, `src/lib/ai/agent.ts`).
- Correo de alertas: quitar el correo personal de Allan como valor por defecto (`lib/finanzas-stack.ts:221`); debe venir de configuración, sin valor por defecto personal.
- Calendario de pago fijo (`src/lib/dates.ts:71-106`): lo sustituye `INC#` del diseño.
- Cuentas fijas (`src/lib/accounts.ts:4`, `src/lib/types.ts:80`) y señales "BI = débito" (`src/lib/guards.ts:21-30`): las sustituye el diseño de cuentas dinámicas.

### 4.3 Funcionalidad nueva (en orden de dependencia)

1. **Cuentas dinámicas** con partida doble y centavos (diseño, secciones 2–3).
2. **Reconocimiento por terminación y alias** (diseño, sección 4).
3. **Ciclos de tarjeta** con avisos de corte y pago en el guardián (diseño, sección 5).
4. **Ingresos esperados** configurables y conciliación (diseño, sección 6).
5. **Cifras de "libre"**: disponible, deuda total, libre hasta el próximo pago, libre después del salario; comando `/libre` (diseño, sección 7).
6. **Avisos de presupuesto al registrar** (llamar a `budgetProgress` en `warningsFor`) y tope global mensual opcional.
7. **Foto diaria `SNAP#`** escrita por el guardián (base de la gráfica de "libre").
8. **Dashboard Telegram Mini App**: barras de deuda por tarjeta al corte vs límite, dona de participación, línea de "libre" con proyección (análisis, sección 8).

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

- **Commits:** Git firma con SSH (`commit.gpgsign=true`, llave en `~/.ssh`); el sandbox no da acceso, así que Claude deja el staging y el mensaje y **Luis ejecuta el commit**. No usar `--no-gpg-sign`.
- **`.env*`:** ni lectura ni `stat` desde el sandbox; `git add -A` falla si hay un `.env*` sin seguimiento (usar pathspec de exclusión, p. ej. `':!*.example'`). Los comandos que nombran `.env` pueden ser rechazados por la regla de permisos.
- **npm:** el sandbox no deja escribir en `~/.npm/_cacache`; usar `--cache` en un directorio temporal. El mensaje de npm sobre "archivos de root" es engañoso: no hace falta `sudo chown`.
- **Red:** el sandbox sale por un proxy (`HTTPS_PROXY`). `curl` y npm lo usan; el descargador de Puppeteer no.
- **Mermaid:** no hay renderizador instalado. Chrome headless no arranca dentro del sandbox (puerto Mach denegado); el render lo ejecuta Luis en su terminal. El `chrome-headless-shell` de Chrome for Testing viene con firma ad-hoc, sin notarizar. Tras usarlo, borrar la instalación temporal.
- **Escritura:** este repo debe estar añadido a la sesión (abrir Claude Code aquí o `/add-dir`).
