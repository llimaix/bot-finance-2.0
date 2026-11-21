# DISEÑO DEL MODELO DE CUENTAS DINÁMICAS

| Dato | Valor |
|---|---|
| Fecha | 2026-11-21 |
| Proyecto base | `bot-finance` (commit `b3d9e07`), solo como referencia; este diseño no modifica ese repositorio |
| Documento relacionado | `analisis-bot-finance.md`, secciones 6 y 7 |
| Supuestos | El bot es solo para Luis y parte de cero. Las cuentas de los ejemplos son ilustrativas; los datos reales solo cambian valores, no el modelo |
| Estado | Decisiones de diseño tomadas (sección 11). Falta solo el inventario de cuentas e ingresos (sección 11.3) |

---

## 1. PROBLEMA QUE RESUELVE

En el código actual:

- las cuentas son una lista fija de cinco (`types.ts:80`), con una sola tarjeta de crédito;
- el saldo se deduce combinando `type` + `method` + `category` en `accountDelta()` (`accounts.ts`), con una excepción por cada incidente (31-jul, 3-sep, 1-oct);
- la cuenta se reconoce con expresiones regulares fijas, entre ellas "BI = débito" (`guards.ts:21-30`);
- el calendario de pago está fijo en el código (`dates.ts:71-106`);
- no existen fechas de corte, fechas de pago, límites ni terminaciones de tarjeta.

---

## 2. IDEA CENTRAL: PARTIDA DOBLE SIMPLIFICADA

Cada movimiento declara de dónde **sale** y a dónde **entra** el dinero.

```ts
interface Movimiento {
  sk: string;                 // TXN#<fecha>#<ulid>
  fecha: string;              // yyyy-mm-dd (hora de Guatemala)
  montoCentavos: number;      // entero > 0 (sin punto flotante)
  tipo: 'gasto' | 'ingreso' | 'transferencia';  // solo para reportes y metas
  origen: string | null;      // accountId de donde SALE; null = mundo exterior
  destino: string | null;     // accountId a donde ENTRA; null = mundo exterior
  categoria: string;
  descripcion: string;
  cuentaFuente: 'terminacion' | 'alias' | 'modelo' | 'usuario'; // auditoría
  // shortId, rawMessage, createdAt y emoji: igual que hoy
}
```

El saldo deja de tener casos especiales:

```ts
saldo(cuenta) = semilla
              + Σ montos donde destino === cuenta
              − Σ montos donde origen  === cuenta
```

| Caso real | origen | destino | Efecto |
|---|---|---|---|
| Almuerzo con débito BI | `bi-debito` | `null` | BI baja |
| Súper con crédito BAC | `bac-visa` | `null` | La deuda BAC crece (más negativa) |
| Salario a BI | `null` | `bi-debito` | BI sube |
| Retiro en cajero | `bi-debito` | `efectivo` | BI baja, efectivo sube |
| Depósito de efectivo a Banrural | `efectivo` | `banrural` | Simétrico |
| Pago de tarjeta BAC desde BI | `bi-debito` | `bac-visa` | BI baja y la deuda BAC baja |
| Transferencia a Kash | `bi-debito` | `kash` | Movimiento entre cuentas propias |

Los tipos `retiro` y `deposito` desaparecen: son transferencias entre cuentas propias. Los tres incidentes documentados en el código pasan a ser imposibles por construcción, no por una regla más.

---

## 3. CUENTAS COMO DATOS (`ACC#<id>`)

```ts
interface Cuenta {
  id: string;                 // slug estable: 'bi-debito', 'bac-visa', 'bi-mastercard'
  nombre: string;             // 'Visa BAC'
  tipo: 'banco' | 'credito' | 'efectivo' | 'billetera';
  banco: string | null;       // 'BI', 'BAC', 'Banrural'
  terminaciones: string[];    // ['1234', '9876'] (titular y adicional)
  alias: string[];            // ['la bac', 'visa', 'la de crédito']
  semillaCentavos: number;    // saldo al cierre de asOf; crédito = deuda en negativo
  asOf: string;
  estimada: boolean;
  activa: boolean;            // cerrar una cuenta no borra su historial
  credito?: {
    limiteCentavos: number;
    diaCorte: number;         // 1..31 (31 = último día del mes)
    diaPago: number;          // si ≤ diaCorte, cae el mes siguiente
    ajustePago: 'siguiente_habil' | 'anterior_habil' | 'ninguno';
    diasAviso: number[];      // p. ej. [5, 2, 0] antes de la fecha de pago
  };
}
```

### 3.1 Invariantes (las valida el código, no el modelo de lenguaje)

- `origen !== destino`, y al menos uno de los dos no es nulo.
- Un `gasto` necesita `origen`; un `ingreso` necesita `destino`.
- Una cuenta de crédito nunca es `destino` de un `ingreso`; si ocurre, se avisa porque casi seguro es un error.
- Cada terminación pertenece a una sola cuenta.
- `montoCentavos` es un entero mayor que 0 (cierra también el hallazgo M3 del análisis).

---

## 4. CÓMO SE DECIDE LA CUENTA

Las fuentes se consultan en este orden de precedencia, y cada movimiento guarda cuál decidió (`cuentaFuente`):

1. **Terminación.** Solo con contexto explícito: `termina(da)? en 1234`, `****1234`, `xxxx1234`, `final 1234`, o el campo `terminacion` que devuelva la visión del voucher. Nunca 4 dígitos sueltos: en "gasté 1234 en el súper" eso es un monto.
2. **Alias o banco inequívoco.** Si "BAC" coincide con una sola cuenta, esa es. Si coincide con varias (BAC débito y BAC crédito), se filtra con "crédito"/"débito" en el texto; si sigue ambiguo, no se impone nada.
3. **Propuesta del modelo.** El esquema zod del agente se arma dinámicamente con los IDs existentes (`z.enum([...idsActivos])`): el modelo no puede inventar una cuenta.
4. **Preguntar** con botones inline de las cuentas posibles (sustituye al `method: 'na'` actual).

Este mecanismo sustituye la lista `ACCOUNT_SIGNALS` de `guards.ts`, que tiene fijo "BI = débito".

---

## 5. CICLO DE CADA TARJETA DE CRÉDITO

### 5.1 Cálculo

Para una tarjeta con corte el día C:

- **Periodo:** desde el día siguiente al corte anterior hasta C. `diaCorte = 31` en febrero se ajusta al último día del mes.
- **Saldo al corte:** saldo de la cuenta con los movimientos hasta C inclusive.
- **Fecha de pago:** `diaPago` en el mismo mes o el siguiente, ajustada a día hábil según `ajustePago`.
- **Pagado en el ciclo:** suma de los movimientos con `destino = tarjeta` entre el día siguiente al corte y la fecha de pago.
- **Pendiente:** saldo al corte − pagado.

### 5.2 Item guardado (`CYC#<cuenta>#<yyyy-mm>`)

Lo escribe el guardián el día siguiente al corte:

```ts
interface CicloTarjeta {
  cuentaId: string;
  fechaCorte: string;
  fechaPago: string;
  saldoAlCorteCalculado: number;   // centavos
  saldoEstadoCuenta?: number;      // si el usuario lo corrige con su estado real
  pagoMinimo?: number;             // solo puede venir del estado de cuenta (texto o foto)
}
```

Guardarlo da historial para la gráfica de barras del dashboard y permite que el **estado de cuenta real** prevalezca sobre el cálculo ("mi estado BAC dice Q3,450.20").

### 5.3 Avisos (en el guardián de las 08:30, sin schedules nuevos)

| Momento | Mensaje |
|---|---|
| 3 días antes del corte | "Tu Visa BAC corta el viernes; llevas Q2,140 en este periodo" |
| Día siguiente al corte | "Visa BAC cortó en Q3,450.20. Pago antes del 12-dic" |
| Según `diasAviso` antes del pago | "Faltan 2 días para pagar Q3,450.20 de Visa BAC (pendiente Q1,450.20)" |
| Pago vencido con pendiente | "⚠️ Venció el pago de Visa BAC y faltan Q1,450.20" |
| Uso mayor al 80 % del límite | "Visa BAC al 85 % de su límite" |

---

## 6. INGRESOS ESPERADOS (`INC#<slug>`)

Sustituye el calendario fijo de `dates.ts:71-106`.

```ts
interface IngresoEsperado {
  slug: string;                 // 'salario'
  descripcion: string;
  montoCentavos: number;        // neto esperado
  cuentaDestino: string;        // 'bi-debito'
  dias: number[];               // [15, 31] quincenal; [25] mensual; 31 = último día
  ajuste: 'anterior_habil' | 'siguiente_habil' | 'ninguno';
  activo: boolean;
}
```

- **Se declara desde el primer día** ("me pagan Q8,000 el 15 y el último"), sin esperar 2 o 3 meses a que lo detecte el sistema de recurrentes.
- **Conciliación automática:** un `ingreso` hacia `cuentaDestino`, dentro de ±3 días de la fecha esperada y con un monto dentro de ±10 %, marca ese pago como recibido ("✅ Salario de la quincena recibido").
- **El plan de quincena** (`kind: 'payday'`) lee estas fechas en lugar de la regla fija del 15 y fin de mes.

---

## 7. DEFINICIONES DE "LIBRE"

Hoy el "neto líquido" mezcla activos y deuda. Se separan las cifras:

| Cifra | Fórmula |
|---|---|
| Disponible hoy | Σ saldos de `banco` + `efectivo` + `billetera` (sin crédito) |
| Deuda total | Σ \|saldos de `credito`\| |
| Libre hasta tu próximo pago | disponible hoy − pagos de tarjeta pendientes con fecha de pago ≤ próximo ingreso − recurrentes pendientes ≤ próximo ingreso − gasto variable diario × días hasta el próximo ingreso |
| Libre después del salario | libre hasta tu próximo pago + monto del próximo ingreso − obligaciones entre ese ingreso y el siguiente |

El crédito disponible **no** cuenta como libre: es deuda potencial, no dinero. Se muestra aparte como "crédito disponible".

---

## 8. CLAVES Y PATRONES DE ACCESO

Todo vive bajo `PK = USER#<chatId>`. El bot es de un solo usuario, pero el valor sale de la configuración (`ALLOWED_CHAT_ID`) y no queda fijo en el código como hoy (`dynamo.ts:30`, `USER#allan`). Cuesta lo mismo y elimina un dato personal del código. Por la misma razón, el nombre del usuario en los prompts pasa a ser configurable.

| Patrón | Operación | ¿Necesita GSI? |
|---|---|---|
| Listar cuentas | Query `begins_with(SK, 'ACC#')` | No |
| Saldo de todas las cuentas | Query `TXN#` desde el `asOf` más antiguo y cálculo en memoria | No (miles de movimientos al año es poco) |
| Ciclo actual de una tarjeta | Query de rango de fechas `TXN#` + filtro por origen/destino | No |
| Historial de cortes | Query `begins_with(SK, 'CYC#<cuenta>#')` | No |
| Ingresos esperados | Query `begins_with(SK, 'INC#')` | No |
| Foto diaria para el dashboard | Query `begins_with(SK, 'SNAP#<yyyy-mm>')` | No |

Un GSI por cuenta (`GSI1PK = ACC#<id>`, `GSI1SK = fecha`) solo haría falta si el volumen creciera mucho.

---

## 9. CAMBIOS EN EL BOT

**Agente:**

- `registrar_movimientos` pasa a usar `origen`/`destino` en lugar de `method`.
- Herramientas nuevas: `crear_cuenta`, `editar_cuenta`, `consultar_tarjetas`, `registrar_estado_cuenta` (saldo al corte y pago mínimo) y `configurar_ingreso`.

**Comandos:**

- `/cuentas`: lista, alta y edición.
- `/tarjetas`: deuda, corte, pago y uso del límite de cada tarjeta.
- `/libre`: las cifras de la sección 7.

**Alta guiada:** la primera vez, el bot pregunta qué cuentas y tarjetas existen, sus terminaciones, días de corte y pago, y el calendario de ingresos. Las altas y cambios de cuentas se confirman con botones.

---

## 10. MIGRACIÓN Y PRUEBAS

### 10.1 Migración (solo si hubiera que conservar datos existentes)

Partiendo de cero no aplica. Si alguna vez hiciera falta:

1. Convertir cada movimiento viejo a `origen`/`destino` con un script determinista que use la lógica actual de `accountDelta`.
2. **Red de seguridad:** un test que, para todo el historial, compruebe que el saldo con el modelo nuevo es igual al saldo con el viejo, cuenta por cuenta. Si un solo centavo difiere, la migración no se aplica.

### 10.2 Casos de prueba mínimos

- Pago de tarjeta: baja la deuda y baja el banco (los casos de los incidentes 3-sep y 1-oct).
- "termina en 1234" impone la cuenta; "gasté 1234" no la impone.
- "BAC" ambiguo entre débito y crédito: se pregunta.
- Corte el 31 en febrero, en año bisiesto y en año normal.
- `diaPago` menor que `diaCorte`: la fecha de pago cae el mes siguiente.
- Pago parcial: el pendiente es correcto.
- Conciliación del ingreso en el límite de ±3 días y ±10 %.
- Un `z.enum` dinámico rechaza una cuenta inexistente.
- Centavos: 0,10 + 0,20 da exactamente 30 centavos.

---

## 11. DECISIONES TOMADAS (2026-11-21)

### 11.1 Decisiones y consecuencias

| Decisión | Consecuencia en el modelo |
|---|---|
| **Sin saldo en dólares** | Una sola moneda (GTQ) por cuenta: cada tarjeta tiene un único saldo y un único límite. No hacen falta cuentas vinculadas ni saldos dobles |
| **Sin compras a cuotas** | Cada compra entra completa en el ciclo donde ocurre. No se modelan planes de cuotas ni intereses |
| **Solo para Luis** | Sin multiusuario. La autenticación del bot y del dashboard (Mini App) sigue siendo `ALLOWED_CHAT_ID`. La `PK` y el nombre del usuario salen de la configuración (sección 8) |

### 11.2 Limitaciones conocidas (aceptadas)

1. **Suscripciones cobradas en USD a una tarjeta en GTQ** (Anthropic, Apple y similares). El banco las cobra en quetzales con su propio tipo de cambio y posibles comisiones; el bot convierte con `USD_GTQ_RATE` (7.80 por defecto). El monto registrado puede diferir en algunos quetzales del estado de cuenta.
   - **Mitigación:** al corte, `saldoEstadoCuenta` prevalece sobre el cálculo y la diferencia se muestra ("ajuste de Q3.40 por tipo de cambio"). Alternativa: corregir el movimiento cuando se vea el cargo real.
2. **Compras a cuotas.** Si algún día se hace una, el bot la cargaría completa en ese corte y sobrestimaría el pago del ciclo. Si se vuelve habitual, habría que añadir el modelo de cuotas.

### 11.3 Datos pendientes del usuario

Solo se necesitan los últimos 4 dígitos de cada tarjeta, nunca el número completo:

| Cuenta | Banco | Tipo (débito, crédito, efectivo, billetera) | Últimos 4 | Día de corte | Día de pago | Límite |
|---|---|---|---|---|---|---|
| | | | | | | |

Salario: monto neto aproximado, días de pago y cuenta donde se deposita.

---

## 12. NOTA SOBRE EL DIAGRAMA

El diagrama `diagramas/03-modelo-cuentas-propuesto.png` del análisis es anterior a este diseño y difiere en detalles:

- usa `cuentaOrigen`/`cuentaDestino` en lugar de `origen`/`destino`;
- `INGRESO_ESPERADO` tiene `frecuencia` en lugar de `dias[]`;
- no incluye `alias`, `activa`, `cuentaFuente` ni `ajustePago`.

La estructura (entidades y relaciones) es la misma. Si se actualiza el `.mmd`, hay que volver a renderizar el PNG.
