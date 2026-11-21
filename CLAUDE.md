# bot-finance-2.0

Bot de Telegram de finanzas personales (GTQ), serverless en AWS (CDK v2, Lambdas arm64, DynamoDB single-table) con IA vía Vercel AI SDK. Es **solo para Luis**.

## Origen

- Base importada como copia limpia (`git archive`) del commit `b3d9e07` de `github.com/Allan-Sanchez/bot-finance`, con autorización de Allan. Commit de importación: `ccf85c1`.
- El repo original (`~/Developer/bot-finance`) es **de solo lectura**: no se crean ramas, archivos ni push ahí. Todo el trabajo va en este repo.

## Dónde estamos y qué sigue

Lee **`docs/estado-y-pendientes.md`** al empezar cada sesión: contiene el estado, los pendientes priorizados, las decisiones tomadas y los datos que faltan.

Documentos de referencia:
- `docs/analisis-bot-finance.md`: análisis técnico y funcional (hallazgos H1–H2, M1–M7 y bajos, con `archivo:línea`).
- `docs/diseno-cuentas-dinamicas.md`: diseño del modelo de cuentas dinámicas (partida doble, tarjetas, cortes, ingresos).
- `docs/diagramas/`: fuentes Mermaid (`.mmd`) e imágenes (`.png`).

## Reglas del proyecto

- Los commits los hace Luis (están firmados con SSH y el sandbox no da acceso a `~/.ssh`). Claude prepara el staging, revisa `git diff --staged` y deja el mensaje en Conventional Commits.
- Nunca push sin petición explícita.
- `.env*` no es legible desde el sandbox; cualquier verificación de esos archivos la ejecuta Luis.
- Datos financieros: nada de montos, saldos ni datos personales reales en código, tests, logs ni commits.
- Antes de cambiar infraestructura: mostrar identidad y contexto de AWS (`aws sts get-caller-identity`) y usar `cdk diff` antes de cualquier deploy. Sin deploy sin petición explícita.
