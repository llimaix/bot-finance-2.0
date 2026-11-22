# DISEÑO DEL MODELO DE CUENTAS DINÁMICAS

| Dato | Valor |
|---|---|
| Fecha | 2026-11-21 (actualizado 2026-11-22: intereses de tarjeta, entidades bancarias con alias, terminación desde imágenes y nombre de usuario dinámico) |
| Proyecto base | `bot-finance` (commit `b3d9e07`), solo como referencia; este diseño no modifica ese repositorio |
| Documento relacionado | `analisis-bot-finance.md`, secciones 6 y 7 |
| Supuestos | El bot es solo para Luis y parte de cero. Las cuentas de los ejemplos son ilustrativas; los datos reales solo cambian valores, no el modelo |
| Estado | Decisiones de diseño tomadas (sección 11). Los datos del usuario se capturan en el alta guiada del bot, no en documentos (sección 11.3) |

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
  entidadId: string | null;   // 'bi', 'bac', 'banrural' → BNK#<id> (sección 3.2); null en efectivo
  terminaciones: string[];    // ['1234', '9876'] (titular y adicional)
  alias: string[];            // propios de la cuenta: ['la bac', 'visa', 'la de crédito']
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
    interes?: {               // OPCIONAL al registrar la tarjeta (sección 5.4)
      tasaBps: number;        // puntos básicos, entero: 3.5 % = 350 (sin punto flotante)
      periodo: 'mensual' | 'anual';  // como la publica el banco
    };
  };
}
```

### 3.1 Invariantes (las valida el código, no el modelo de lenguaje)

- `origen !== destino`, y al menos uno de los dos no es nulo.
- Un `gasto` necesita `origen`; un `ingreso` necesita `destino`.
- Una cuenta de crédito nunca es `destino` de un `ingreso`; si ocurre, se avisa porque casi seguro es un error.
- Cada terminación pertenece a una sola cuenta.
- `montoCentavos` es un entero mayor que 0 (cierra también el hallazgo M3 del análisis).
- Un alias normalizado (sección 3.2) pertenece a una sola entidad o a una sola cuenta, nunca a dos.
- `interes.tasaBps`, si existe, es un entero mayor que 0; solo las cuentas `credito` pueden tenerlo.

### 3.2 Entidades bancarias (`BNK#<id>`)

Los alias del banco se registran una vez y valen para todas sus cuentas: "Banco Industrial", "BI" y "el Industrial" son la misma entidad, sea la cuenta de débito o la tarjeta.

```ts
interface EntidadBancaria {
  id: string;                 // 'bi'
  nombre: string;             // 'Banco Industrial'
  alias: string[];            // ['bi', 'banco industrial', 'industrial']
}
```

- **Normalización:** antes de comparar, el texto y los alias se pasan a minúsculas, sin tildes y con los espacios colapsados. "Banco Industrial", "banco industrial" y "BANCO INDUSTRIAL" coinciden.
- **Alta:** al crear la primera cuenta de un banco, el agente crea la entidad con sus alias más comunes y muestra el resumen con ↩️ Deshacer. Después se pueden añadir alias en lenguaje natural ("a BI también le digo el Industrial").
- **Relación con los alias de la cuenta:** los de la entidad identifican el banco; los de la cuenta, una cuenta concreta ("la visa", "la de crédito"). La sección 4 combina ambos.

---

## 4. CÓMO SE DECIDE LA CUENTA

Las fuentes se consultan en este orden de precedencia, y cada movimiento guarda cuál decidió (`cuentaFuente`):

1. **Terminación.** Solo con contexto explícito: `termina(da)? en 1234`, `****1234`, `xxxx1234`, `•••• 1234`, `final 1234`, o el campo `terminacion` que devuelva la visión. Nunca 4 dígitos sueltos: en "gasté 1234 en el súper" eso es un monto.
2. **Alias.** Primero los de la cuenta ("la visa" → `bac-visa`). Si no hay, los de la entidad (sección 3.2): "Banco Industrial" o "BI" reducen las candidatas a las cuentas de esa entidad. Si queda una, esa es. Si quedan varias (BI débito y BI crédito), se filtra con "crédito"/"débito" en el texto; si sigue ambiguo, no se impone nada.
3. **Propuesta del modelo.** El esquema zod del agente se arma dinámicamente con los IDs existentes (`z.enum([...idsActivos])`): el modelo no puede inventar una cuenta.
4. **Preguntar** con botones inline de las cuentas posibles (sustituye al `method: 'na'` actual).

Este mecanismo sustituye la lista `ACCOUNT_SIGNALS` de `guards.ts`, que tiene fijo "BI = débito".

### 4.1 Terminación desde imágenes

El usuario no tiene que decir con qué tarjeta pagó si la imagen lo muestra. Aplica a cualquier imagen: voucher, ticket, captura de la wallet del teléfono, de la app del banco o de una notificación de cobro.

- **Esquema de visión:** el resultado incluye `terminacion: string | null`, con exactamente 4 dígitos. El prompt pide extraerla **solo** si aparece como número de tarjeta enmascarado (`•••• 1111`, `**** 1111`, `XXXX1111`, "terminada en 1111"), nunca de montos, fechas, teléfonos ni números de autorización.
- **Resolución en código:** la terminación se busca en `terminaciones` de las cuentas activas. Si coincide con una, esa cuenta se impone con `cuentaFuente: 'terminacion'`, aunque el texto o el modelo digan otra cosa.
- **Terminación desconocida:** el bot no adivina. Pregunta a qué cuenta pertenece, con botones, y al confirmar la **añade** a `terminaciones` de esa cuenta. La próxima imagen con esa tarjeta se resuelve sola.
- **Privacidad:** solo se guardan los últimos 4 dígitos. Si la visión llegara a leer más dígitos, el código descarta todo salvo los 4 últimos y nunca los registra en logs.

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

El item también admite `interesesCobrados?: number` (centavos), tomado del estado de cuenta cuando el banco cobra intereses (sección 5.4).

### 5.3 Avisos (en el guardián de las 08:30, sin schedules nuevos)

| Momento | Mensaje |
|---|---|
| 3 días antes del corte | "Tu Visa BAC corta el viernes; llevas Q2,140 en este periodo" |
| Día siguiente al corte | "Visa BAC cortó en Q3,450.20. Pago antes del 12-dic" |
| Según `diasAviso` antes del pago | "Faltan 2 días para pagar Q3,450.20 de Visa BAC (pendiente Q1,450.20)" |
| Pago vencido con pendiente | "⚠️ Venció el pago de Visa BAC y faltan Q1,450.20" |
| Uso mayor al 80 % del límite | "Visa BAC al 85 % de su límite" |
| Antes del pago, si la tarjeta tiene tasa | "Si no pagas el total de Visa BAC, el interés estimado es ~Q120" (sección 5.4) |

### 5.4 Intereses (opcional)

La tasa es un dato **opcional** al registrar la tarjeta (`credito.interes`). Sin tasa, todo funciona igual que sin intereses.

- **Para qué sirve:** mostrar el costo de no pagar el total. En `/tarjetas` y en los avisos de pago: "interés estimado si pagas solo el mínimo o una parte".
- **Estimación:** pendiente después de la fecha de pago × tasa mensual. Si la tasa es anual, se divide entre 12. El cálculo es en centavos enteros, con la tasa en puntos básicos.
- **Es una estimación y se muestra como tal ("~").** Cada banco calcula el interés a su manera (saldo promedio diario, fechas de cada compra), así que el bot no intenta replicarlo.
- **El cargo real prevalece:** cuando el estado de cuenta trae intereses, se registran como un movimiento `gasto` con `origen = tarjeta` y categoría `intereses`, y se guardan en `interesesCobrados` del ciclo. Así entran en la deuda real y en los reportes.
- **Sin cuotas:** los intereses de compras a cuotas siguen fuera del alcance (sección 11.2).

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

Todo vive bajo `PK = USER#<chatId>`. El bot es de un solo usuario, pero el valor sale de la configuración (`ALLOWED_CHAT_ID`) y no queda fijo en el código como hoy (`dynamo.ts:30`, `USER#allan`). Cuesta lo mismo y elimina un dato personal del código.

**Perfil del usuario (`CFG#perfil`).** El nombre con el que el bot se dirige al usuario es un dato, no configuración de despliegue: se cambia **en caliente**, sin redesplegar.

```ts
interface Perfil {
  nombre: string;             // 'Luis'
  actualizadoEn: string;
}
```

- Se pregunta en el alta guiada y se cambia con `/nombre Luis` o diciendo "llámame Luis" (herramienta `configurar_perfil`).
- Los prompts y las descripciones de las herramientas se construyen en cada mensaje con el nombre del perfil. Hoy dicen "Allan" en 7 archivos de `src/`.
- Sin perfil, el bot usa un trato neutro ("tú") hasta que se configure.

| Patrón | Operación | ¿Necesita GSI? |
|---|---|---|
| Listar cuentas | Query `begins_with(SK, 'ACC#')` | No |
| Saldo de todas las cuentas | Query `TXN#` desde el `asOf` más antiguo y cálculo en memoria | No (miles de movimientos al año es poco) |
| Ciclo actual de una tarjeta | Query de rango de fechas `TXN#` + filtro por origen/destino | No |
| Historial de cortes | Query `begins_with(SK, 'CYC#<cuenta>#')` | No |
| Ingresos esperados | Query `begins_with(SK, 'INC#')` | No |
| Entidades bancarias y sus alias | Query `begins_with(SK, 'BNK#')` | No |
| Perfil del usuario | GetItem `CFG#perfil` | No |
| Foto diaria para el dashboard | Query `begins_with(SK, 'SNAP#<yyyy-mm>')` | No |

Un GSI por cuenta (`GSI1PK = ACC#<id>`, `GSI1SK = fecha`) solo haría falta si el volumen creciera mucho.

---

## 9. CAMBIOS EN EL BOT

**Principio: el chat es la única vía de escritura; la Mini App solo lee.**

- Todo dato (cuentas, entidades, alias, terminaciones, recurrentes, ingresos, perfil y movimientos) entra por el chat y pasa por las mismas funciones del backend, que validan las invariantes en código (sección 3.1).
- La Mini App (análisis, sección 8) es un reporte visual de lo registrado: no expone endpoints de escritura. Una sesión robada o un error en el front no pueden modificar datos.
- Los datos personales (bancos, terminaciones, límites, tasas, salario) viven solo en DynamoDB. Nunca en el repositorio, que es público.

**La configuración la hace el agente, sin tarjetas de confirmación** (decisión del 2026-11-22). El agente interpreta la instrucción ("agrega mi Visa BAC terminada en 1111, corta el 15", "llámame Luis") y llama a la herramienta, que valida en código y guarda. El seguro no es pedir permiso antes, sino mostrar exactamente qué se guardó después:

| Dato | Cómo se aplica |
|---|---|
| Nombre, alias, metas | Directo: el agente guarda y lo dice en su respuesta. Se corrige con otro mensaje |
| Cuentas, tarjetas, terminaciones, ingresos y recurrentes | Directo con **resumen y deshacer**: el bot añade un resumen generado por **código** con lo que quedó guardado ("Visa BAC · ••1111 · corte 15 · pago 5 · límite Q10,000") y un solo botón **↩️ Deshacer**. Si está bien, no hay que hacer nada |
| Movimientos | Igual que hoy: se registran al momento, con su botón 🗑️ |

- **Por qué el resumen lo genera el código:** si el modelo malinterpreta (por ejemplo, asigna una terminación a la cuenta equivocada), el error se ve en ese mismo mensaje, no semanas después en los saldos. El resumen describe lo guardado en DynamoDB, no lo que el modelo cree haber hecho.
- **↩️ Deshacer** restaura el estado anterior del item (alta → se borra; cambio → vuelve el valor previo). Caduca a las 24 h y solo deshace esa operación.
- **Revisión cómoda en el chat:** `/cuentas` y `/tarjetas` listan todo lo configurado, para no depender de la memoria del usuario.

**Recurrentes declarados.** Hoy los recurrentes solo se aprenden del historial tras dos o tres meses (`REC#`, estado `candidato`). En la 2.0 también se declaran desde el primer día ("pago Netflix Q80 cada 10 con la BAC"): el item `REC#` añade `origen: 'aprendido' | 'declarado'`, la cuenta de cargo y el día. Los declarados entran directamente como `confirmado` y cuentan en "libre" y en la proyección.

**Agente:**

- `registrar_movimientos` pasa a usar `origen`/`destino` en lugar de `method`.
- Herramientas nuevas: `crear_cuenta` (con tasa de interés opcional), `editar_cuenta`, `gestionar_entidad` (alta de la entidad y sus alias), `consultar_tarjetas`, `registrar_estado_cuenta` (saldo al corte, pago mínimo e intereses cobrados), `configurar_ingreso`, `declarar_recurrente` y `configurar_perfil` (nombre del usuario). Guardan directamente; las de cuentas, tarjetas, terminaciones, ingresos y recurrentes devuelven además el resumen y el identificador para ↩️ Deshacer.

**Visión:** el esquema de comprobantes añade `terminacion` (sección 4.1) y el prompt deja de suponer que la imagen es un voucher: también acepta capturas de la wallet, de la app del banco y de notificaciones.

**Comandos:**

- `/cuentas`: lista, alta y edición, incluidos alias y terminaciones.
- `/tarjetas`: deuda, corte, pago, uso del límite y, si hay tasa, interés estimado de cada tarjeta.
- `/libre`: las cifras de la sección 7.
- `/nombre <nombre>`: cambia el nombre del perfil.

**Alta conversacional:** la conduce el agente, sin máquina de estados. Si no hay perfil o no hay cuentas configuradas, el contexto del agente lo indica y el agente pregunta de forma natural: el nombre con el que llamar al usuario; las entidades y sus alias; las cuentas y tarjetas, con sus terminaciones, días de corte y pago, límite y tasa de interés si se conoce; los ingresos esperados; y los recurrentes que ya se conozcan. El usuario puede darlo todo en un mensaje o por partes, y dejar cosas para después. Cada alta muestra su resumen con ↩️ Deshacer. Los datos nunca pasan por el repositorio.

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
- Alias de entidad: "Banco Industrial", "BI" y "banco industrial" resuelven la misma entidad; con una sola cuenta de esa entidad se impone, con dos se filtra por "crédito"/"débito" o se pregunta.
- Un mismo alias no puede quedar asignado a dos entidades o cuentas.
- Captura de wallet con `•••• 1111` registrada en BI crédito: se impone esa cuenta sin texto adicional.
- Imagen con una terminación desconocida: se pregunta la cuenta y, al confirmar, la terminación queda guardada.
- Imagen con un número de autorización o un teléfono de 4 dígitos visibles: no se toma como terminación.
- Interés: tasa mensual de 350 bps y pendiente de Q1,000.00 dan ~Q35.00; la misma tasa expresada como anual (4 200 bps) da el mismo resultado.
- Tarjeta sin tasa: no se muestra ninguna estimación de interés.
- Cambio de nombre con `/nombre` o "llámame Luis": el siguiente mensaje ya usa el nombre nuevo, sin redesplegar.
- Alta de cuenta en lenguaje natural: se guarda al momento y el resumen muestra exactamente lo guardado; ↩️ Deshacer la elimina.
- ↩️ Deshacer de un cambio restaura el valor anterior; pasadas 24 h ya no hace nada.
- Recurrente declarado: cuenta en "libre" desde el primer mes, sin esperar al aprendizaje.

---

## 11. DECISIONES TOMADAS (2026-11-21)

### 11.1 Decisiones y consecuencias

| Decisión | Consecuencia en el modelo |
|---|---|
| **Sin saldo en dólares** | Una sola moneda (GTQ) por cuenta: cada tarjeta tiene un único saldo y un único límite. No hacen falta cuentas vinculadas ni saldos dobles |
| **Sin compras a cuotas** | Cada compra entra completa en el ciclo donde ocurre. No se modelan planes de cuotas |
| **Solo para Luis** | Sin multiusuario. La autenticación del bot y del dashboard (Mini App) sigue siendo `ALLOWED_CHAT_ID`. La `PK` sale de la configuración (sección 8) |
| **Intereses de tarjeta opcionales** (2026-11-22; sustituye "ni intereses") | Tasa opcional por tarjeta en puntos básicos, con su periodo. Se usa para estimar el costo de no pagar el total; el cargo real del estado de cuenta prevalece (sección 5.4) |
| **Alias por entidad bancaria** (2026-11-22) | Nueva entidad `BNK#` con alias que valen para todas sus cuentas, además de los alias propios de cada cuenta (secciones 3.2 y 4) |
| **Terminación desde cualquier imagen** (2026-11-22) | La visión extrae la terminación de vouchers y capturas de wallet, app o notificaciones; las desconocidas se aprenden tras confirmar (sección 4.1) |
| **Nombre de usuario dinámico** (2026-11-22) | El nombre es un dato del perfil (`CFG#perfil`), editable sin redesplegar (sección 8) |
| **Chat para escribir, Mini App para leer** (2026-11-22) | Toda alta y edición la hace el agente por chat, sin tarjetas de confirmación; en cuentas y tarjetas, resumen con ↩️ Deshacer; la Mini App es solo un reporte visual. Los datos personales no pasan por el repositorio (sección 9) |
| **Recurrentes declarados** (2026-11-22) | Además de aprendidos, los recurrentes se pueden declarar desde el primer día (sección 9) |

### 11.2 Limitaciones conocidas (aceptadas)

1. **Suscripciones cobradas en USD a una tarjeta en GTQ** (Anthropic, Apple y similares). El banco las cobra en quetzales con su propio tipo de cambio y posibles comisiones; el bot convierte con `USD_GTQ_RATE` (7.80 por defecto). El monto registrado puede diferir en algunos quetzales del estado de cuenta.
   - **Mitigación:** al corte, `saldoEstadoCuenta` prevalece sobre el cálculo y la diferencia se muestra ("ajuste de Q3.40 por tipo de cambio"). Alternativa: corregir el movimiento cuando se vea el cargo real.
2. **Compras a cuotas.** Si algún día se hace una, el bot la cargaría completa en ese corte y sobrestimaría el pago del ciclo. Si se vuelve habitual, habría que añadir el modelo de cuotas.

### 11.3 Datos del usuario

No se recogen en documentos: el repositorio es público. Se capturan en el **alta guiada del bot** (sección 9) y viven solo en DynamoDB. El flujo pide:

- el nombre con el que el bot debe dirigirse al usuario;
- por cada entidad: nombre y alias;
- por cada cuenta o tarjeta: tipo, alias, últimos 4 dígitos (nunca el número completo) y, si es de crédito, día de corte, día de pago, límite y tasa de interés opcional;
- ingresos esperados: monto neto aproximado, días y cuenta de depósito;
- recurrentes conocidos: descripción, monto, día y cuenta de cargo.

---

## 12. NOTA SOBRE EL DIAGRAMA

El diagrama `diagramas/03-modelo-cuentas-propuesto.png` del análisis es anterior a este diseño y difiere en detalles:

- usa `cuentaOrigen`/`cuentaDestino` en lugar de `origen`/`destino`;
- `INGRESO_ESPERADO` tiene `frecuencia` en lugar de `dias[]`;
- no incluye `alias`, `activa`, `cuentaFuente` ni `ajustePago`;
- no incluye la entidad bancaria (`BNK#`), la tasa de interés, `interesesCobrados`, el perfil (`CFG#perfil`) ni el origen de los recurrentes, añadidos el 2026-11-22.

La estructura (entidades y relaciones) es la misma. Si se actualiza el `.mmd`, hay que volver a renderizar el PNG.
