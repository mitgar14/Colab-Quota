# Análisis de Vacíos del Plan Original

> Comparación del plan en `docs/archive/colab-quota-extension-plan.md` contra hallazgos de investigación. Cada sección identifica qué dice el plan, qué dice la realidad, y el impacto.

---

## VACÍO CRÍTICO 1: Endpoint incorrecto

### Plan original
```
GET https://colab.research.google.com/tun/m/ccu-info?authuser=0
```

### Realidad verificada
```
GET https://colab.pa.googleapis.com/v1/user-info?get_ccu_consumption_info=true
```

### Evidencia
- `googlecolab/colab-vscode` (`src/colab/client.ts`): `getConsumptionUserInfo()` construye la URL con `new URL('v1/user-info', this.colabGapiDomain)` y `url.searchParams.set('get_ccu_consumption_info', 'true')`
- `xeodou/colab-cli` (`colab.go`): usa el mismo endpoint sobre `colab.pa.googleapis.com`
- El dominio GAPI de producción es `https://colab.pa.googleapis.com` (confirmado en `scripts/generate-config.mts`)

### Impacto
**BLOQUEANTE.** El endpoint `/tun/m/ccu-info` no aparece en ninguna implementación conocida. Toda la lógica de fetch, parsing, y manejo de errores del plan se construyó sobre un endpoint que probablemente no existe o tiene comportamiento diferente al documentado. El plan completo necesita reescribirse contra el endpoint GAPI correcto.

### Nota sobre dominios duales
La API de Colab opera en dos dominios con roles distintos:

| Dominio | Rol | Parámetro `authuser` |
|---------|-----|---------------------|
| `colab.research.google.com` | Tunnel — asignación de runtimes, keep-alive, proxy Jupyter | Sí (obligatorio) |
| `colab.pa.googleapis.com` | GAPI — user-info, cuota, proxy tokens | No |

El plan no menciona esta dualidad.

---

## VACÍO CRÍTICO 2: Estructura de la respuesta JSON incorrecta

### Plan original
```json
{
  "currentBalance": 87.4,
  "consumptionRateHourly": 11.7,
  "assignmentsCount": 1,
  "eligibleGpus": ["T4"],
  "ineligibleGpus": ["A100", "L4"],
  "eligibleTpus": [],
  "ineligibleTpus": [],
  "freeCcuQuotaInfo": {
    "remainingTokens": "1000",
    "nextRefillTimestampSec": 1740000000
  }
}
```

### Realidad verificada (schema Zod de `colab-vscode/src/colab/api.ts`)
```json
{
  "subscriptionTier": "SUBSCRIPTION_TIER_PRO",
  "paidComputeUnitsBalance": 12.5,
  "consumptionRateHourly": 1.96,
  "assignmentsCount": 1,
  "eligibleAccelerators": [
    { "variant": "VARIANT_GPU", "models": ["T4", "L4"] }
  ],
  "ineligibleAccelerators": [
    { "variant": "VARIANT_GPU", "models": ["A100"] }
  ],
  "freeCcuQuotaInfo": {
    "remainingTokens": "14720",
    "nextRefillTimestampSec": 1740000000
  }
}
```

### Diferencias campo por campo

| Plan dice | Realidad | Tipo | Impacto |
|-----------|----------|------|---------|
| `currentBalance` | **`paidComputeUnitsBalance`** | number | Nombre incorrecto; hay que renombrar |
| *(no existe)* | **`subscriptionTier`** | string enum | Campo nuevo: `SUBSCRIPTION_TIER_NONE`, `_PRO`, `_PRO_PLUS`, `_UNSPECIFIED` |
| `eligibleGpus: string[]` | **`eligibleAccelerators: [{variant, models}]`** | array de objetos | Estructura completamente diferente |
| `ineligibleGpus: string[]` | **`ineligibleAccelerators: [{variant, models}]`** | array de objetos | Estructura completamente diferente |
| `eligibleTpus: []` | *(incluido en `eligibleAccelerators` con `variant: "VARIANT_TPU"`)* | — | No es un campo separado |
| `ineligibleTpus: []` | *(incluido en `ineligibleAccelerators`)* | — | No es un campo separado |
| `freeCcuQuotaInfo.remainingTokens: "1000"` | `remainingTokens: "14720"` | string (Int64 Protobuf) | **Unidad diferente: milli-CCU** |

### Errores de conversión críticos

**`remainingTokens` está en milli-CCU, NO en CCU.**

La extensión oficial convierte así:
```typescript
const freeCcu = freeQuota.remainingTokens / 1000;  // milli-CCU → CCU
```

El plan trata `remainingTokens: "1000"` como si fuera 1000 tokens. En realidad, `"1000"` = 1.0 CCU. El plan mostraría un valor **1000x mayor** al real si no se aplica la conversión.

### Impacto
**BLOQUEANTE.** El storage schema, el parsing, toda la lógica de visualización, y los cálculos de estimación de tiempo se basan en campos que no existen o tienen estructura diferente.

---

## VACÍO CRÍTICO 3: Header obligatorio faltante

### Plan original
```
Accept: application/json
Authorization: Bearer <access_token>
X-Goog-Colab-Client-Agent: vscode
```

### Realidad verificada (`colab-vscode/src/colab/headers.ts`)
```
Accept: application/json                    ✓ correcto
Authorization: Bearer <access_token>        ✓ correcto
X-Colab-Client-Agent: vscode               ✗ nombre incorrecto en el plan
```

### Diferencias

| Plan dice | Realidad | Impacto |
|-----------|----------|---------|
| `X-Goog-Colab-Client-Agent` | **`X-Colab-Client-Agent`** | El header tiene nombre distinto; puede causar rechazo del request |

### Headers adicionales no mencionados en el plan

| Header | Cuándo se usa | Requerido para quota |
|--------|--------------|---------------------|
| `X-Colab-Tunnel: Google` | Endpoints del tunnel (`/tun/m/*`) | No (el endpoint de quota usa GAPI) |
| `X-Goog-Colab-Token: <xsrf>` | POSTs con XSRF (assign, unassign) | No |
| `X-Colab-Runtime-Proxy-Token` | Comunicación con el runtime | No |

### Impacto
**MEDIO.** El header `X-Colab-Client-Agent: vscode` es obligatorio según la extensión oficial. El nombre incorrecto en el plan podría causar que el backend rechace el request. Sin embargo, la corrección es trivial.

---

## VACÍO 4: Flujo OAuth2 — Redirect URI

### Plan original
```
Redirect URI: https://<EXTENSION_ID>.chromiumapp.org/
Método: chrome.identity.launchWebAuthFlow
```

### Realidad verificada
La extensión oficial de VS Code usa dos flujos:

| Flujo | Redirect URI | Método |
|-------|-------------|--------|
| `LocalServerFlow` | `http://127.0.0.1:<puerto_efímero>` | Servidor HTTP local |
| `ProxiedRedirectFlow` | `https://colab.research.google.com/vscode/redirect` | Redirect fijo de Colab |

### Análisis para extensión Chrome
El plan propone `launchWebAuthFlow`, que es específico de Chrome y genera automáticamente `https://<EXTENSION_ID>.chromiumapp.org/` como redirect URI. Este enfoque:
- **Funciona** para extensiones Chrome
- **No es lo que usa la extensión oficial**, pero es un enfoque válido para Chrome
- Requiere registrar esta redirect URI en la Google Cloud Console
- Es más simple que levantar un servidor loopback

### Impacto
**BAJO.** El enfoque de `launchWebAuthFlow` es válido para una extensión Chrome personal. La diferencia con la extensión oficial es que VS Code no es un navegador Chrome, así que usa loopback. Para una extensión Chrome, `launchWebAuthFlow` es la opción correcta.

### Decisión pendiente
¿Usar las credenciales propias o las del CLI de xeodou?
- **Credenciales propias**: Requiere crear OAuth2 Desktop App en GCP, registrar redirect URI, agregar cuentas de prueba (max 100)
- **Credenciales de xeodou**: `1014160490159-cvot3bea7tgkp72a4m29h20d9ddo6bne` — puede no funcionar si la redirect URI difiere, y el `client_id` podría ser revocado por Google

---

## VACÍO 5: Manejo de errores insuficiente

### Plan original
```
401 → refresh inmediato; si falla el refresh → UNAUTHENTICATED
429 / 5xx → backoff exponencial
```

### Realidad verificada (extensión oficial)
La extensión implementa un manejo más sofisticado:

| Código | Tratamiento oficial | Plan |
|--------|-------------------|------|
| 401 | Reintento (hasta 2 intentos), invoca `onAuthError()` que refresca token | Solo menciona refresh |
| 412 | `TooManyAssignmentsError` (demasiadas sesiones activas) | **No mencionado** |
| `invalid_grant` (400) | Limpia sesión completa, reinicia auth desde cero | **No mencionado** |
| OAuth client changed (401 en refresh) | Limpia sesión, reinicia | **No mencionado** |

### Errores de dominio no mencionados en el plan

| Error | Cuándo ocurre |
|-------|--------------|
| `InsufficientQuotaError` | Outcome 1 (QUOTA_DENIED) o 2 (QUOTA_EXCEEDED) en assignment |
| `DenylistedError` | Outcome 5 — usuario baneado de Colab |
| `TooManyAssignmentsError` | HTTP 412 — demasiados runtimes simultáneos |

### Impacto
**MEDIO.** Para un endpoint de solo-lectura (quota), los errores 412 y de assignment no aplican directamente. Pero `invalid_grant` sí es crítico: si Google revoca el refresh token o cambia el `client_id`, la extensión debe limpiar todo y pedir re-autenticación, no quedarse en un loop de reintentos.

---

## VACÍO 6: Cálculo de balance máximo

### Plan original
> **Problema conocido**: Colab no expone el balance máximo. Estrategia: usar el primer valor observado como referencia, o permitir que el usuario configure su máximo en el popup.

### Realidad verificada
Ahora existe el campo `subscriptionTier` en la respuesta:

| Tier | Balance típico |
|------|---------------|
| `SUBSCRIPTION_TIER_NONE` (Free) | Sin `paidComputeUnitsBalance`; solo `freeCcuQuotaInfo` |
| `SUBSCRIPTION_TIER_PRO` | ~100 CU/mes |
| `SUBSCRIPTION_TIER_PRO_PLUS` | ~500 CU/mes |

### Mejora posible
Con el `subscriptionTier` se puede inferir un máximo estimado sin pedir al usuario que lo configure. Esto no estaba disponible cuando se escribió el plan (o no se sabía que existía el campo).

### Impacto
**BAJO.** El problema sigue existiendo (el máximo exacto no se expone), pero ahora hay una heurística más informada.

---

## VACÍO 7: Intervalo de polling del endpoint de quota

### Plan original
```
Polling cada 1 minuto via chrome.alarms
```

### Realidad verificada
La extensión oficial de VS Code usa:
```typescript
const POLL_INTERVAL_MS = 1000 * 60 * 5   // 5 minutos
```

### Análisis
- El plan propone **1 minuto** — 5x más frecuente que la extensión oficial
- `chrome.alarms` mínimo real: **30 segundos** (Chrome 120+)
- Un polling cada minuto probablemente es seguro pero innecesariamente agresivo para un dato que cambia lentamente
- La extensión oficial espera 5 minutos, lo que sugiere que Google considera aceptable esa frecuencia

### Impacto
**BAJO.** 1 minuto funciona, pero 5 minutos es lo que Google usa internamente. Considerar hacer configurable o empezar con 5 minutos.

---

## VACÍO 8: Conversión de unidades — `remainingTokens`

### Plan original
```javascript
// Parsea JSON, castea remainingTokens string → number
```

### Realidad verificada
La conversión requiere **DOS pasos**, no uno:

1. **String → Number**: `Number(val)` con verificación `Number.isSafeInteger()`
2. **Milli-CCU → CCU**: `/ 1000`

```typescript
// Extensión oficial: notifier.ts
const freeCcu = freeQuota.remainingTokens / 1000;

// Extensión oficial: api.ts (schema Zod)
remainingTokens: z.string()
  .refine((val) => Number.isSafeInteger(Number(val)))
  .transform((val) => Number(val))
```

### Impacto
**ALTO.** Sin la división entre 1000, la extensión mostraría valores 1000x mayores. Por ejemplo: `remainingTokens: "14720"` → el plan mostraría `14720 tokens` cuando el valor real es `14.72 CCU`.

---

## VACÍO 9: Falta el campo `subscriptionTier`

### Plan original
No menciona el tier de suscripción del usuario.

### Realidad verificada
La respuesta incluye `subscriptionTier` con valores:
```
SUBSCRIPTION_TIER_UNSPECIFIED → SubscriptionTier.NONE (0)
SUBSCRIPTION_TIER_NONE        → SubscriptionTier.NONE (0)
SUBSCRIPTION_TIER_PRO         → SubscriptionTier.PRO (1)
SUBSCRIPTION_TIER_PRO_PLUS    → SubscriptionTier.PRO_PLUS (2)
```

### Usos potenciales
- Determinar el balance máximo estimado (Vacío 6)
- Personalizar la UI (mostrar "Free", "Pro", "Pro+")
- Determinar qué acción sugerir cuando se agotan los CU:
  - Free → "Sign Up for Colab"
  - Pro → "Upgrade to Pro+"
  - Pro+ → "Purchase More CCUs"

### Impacto
**MEDIO.** No tener este campo empobrece la UX y dificulta decisiones de UI.

---

## VACÍO 10: `paidComputeUnitsBalance` es opcional según el tier

### Plan original
Asume que `currentBalance` (ahora `paidComputeUnitsBalance`) siempre existe como número.

### Realidad verificada
En el schema `UserInfoSchema`, `paidComputeUnitsBalance` es **opcional**:
```typescript
paidComputeUnitsBalance: z.number().optional()
```

Solo en `ConsumptionUserInfoSchema` se hace **obligatorio**:
```typescript
.required({ paidComputeUnitsBalance: true })
```

Esto sugiere que si no se pasa `get_ccu_consumption_info=true`, el campo puede no existir.

Para usuarios **Free** sin CU de pago, el valor podría ser `0` o `undefined`. La lógica del plan debe manejar ambos casos.

### Impacto
**MEDIO.** Puede causar `NaN` o errores en la UI si no se maneja el caso `undefined`.

---

## VACÍO 11: Estructura de aceleradores completamente diferente

### Plan original
```json
"eligibleGpus": ["T4"],
"ineligibleGpus": ["A100", "L4"],
"eligibleTpus": [],
"ineligibleTpus": []
```

### Realidad verificada
```json
"eligibleAccelerators": [
  { "variant": "VARIANT_GPU", "models": ["T4", "L4"] }
],
"ineligibleAccelerators": [
  { "variant": "VARIANT_GPU", "models": ["A100"] },
  { "variant": "VARIANT_TPU", "models": ["V5E1"] }
]
```

### Diferencias clave
- No hay campos separados para GPUs y TPUs
- Cada entrada tiene un `variant` (GPU/TPU) y un array de `models`
- Los modelos vienen en uppercase después de la transformación Zod
- Hay un enum `Variant`: `DEFAULT`, `GPU`, `TPU`

### Impacto
**MEDIO.** Toda la lógica de UI que muestra GPUs/TPUs disponibles debe reestructurarse para parsear el formato anidado `{variant, models}`.

---

## VACÍO 12: Prefijo XSSI — ¿Se aplica al endpoint GAPI?

### Plan original
Asume que el prefijo XSSI `)]}'\n` siempre está presente.

### Realidad verificada
- El prefijo se aplica a responses del dominio `colab.research.google.com` (`/tun/m/*`)
- Para el dominio GAPI (`colab.pa.googleapis.com`), la aplicación del prefijo es **inconsistente**
- Tanto `colab-cli` como `colab-vscode` lo manejan de forma defensiva: "si empieza con el prefijo, córtalo"

### Impacto
**BAJO.** El manejo defensivo es correcto. Solo hay que verificar, no asumir.

---

## VACÍO 13: Manejo de service worker efímero

### Plan original
```
Máquina de estados:
UNAUTHENTICATED → ACTIVE → (polling) → REFRESHING
```

### Realidad verificada
El service worker de MV3 se duerme tras 30 segundos de inactividad. Las variables globales se pierden. La máquina de estados del plan no puede vivir en una variable global.

### Lo que falta en el plan
- El estado debe reconstruirse desde `chrome.storage` en cada despertar del SW
- Los tokens en memoria se pierden al dormir → siempre leer de storage
- El flag "refresh en progreso" necesita estar en `chrome.storage.session` para evitar race conditions
- `chrome.alarms.onAlarm` debe registrarse en el nivel superior del SW (no dentro de callbacks)

### Impacto
**ALTO.** Sin este manejo, la extensión fallará silenciosamente cuando el SW se duerma y despierte.

---

## VACÍO 14: Falta lógica de `invalid_grant`

### Plan original
No menciona este escenario.

### Realidad verificada (extensión oficial)
```typescript
// Si el refresh token es revocado por Google:
if (isInvalidGrantError(err)) {
  // 'OAuth app access to Colab was revoked. Clearing session.'
  await clearSession();
  await initialize();  // reiniciar desde cero
}
```

### Impacto
**ALTO.** Sin este manejo, cuando Google revoque el token (lo cual puede pasar), la extensión entrará en un loop infinito de reintentos de refresh sin nunca pedirle al usuario que re-autentique.

---

## VACÍO 15: Timeout del request de quota

### Plan original
No menciona timeouts.

### Realidad verificada
```typescript
const TASK_TIMEOUT_MS = 1000 * 10  // 10 segundos
```

### Impacto
**MEDIO.** Sin timeout, un request colgado puede bloquear la lógica de polling indefinidamente (hasta que el SW se mate a los 5 minutos).

---

## Resumen de prioridades

### Bloqueantes (deben corregirse antes de implementar)
| # | Vacío | Descripción |
|---|-------|-------------|
| 1 | Endpoint incorrecto | `/tun/m/ccu-info` → `colab.pa.googleapis.com/v1/user-info?get_ccu_consumption_info=true` |
| 2 | Estructura JSON incorrecta | Campos renombrados, tipos diferentes, estructura anidada |
| 8 | Conversión de unidades | `remainingTokens` es milli-CCU, necesita `/1000` |

### Altos (pueden causar fallos silenciosos)
| # | Vacío | Descripción |
|---|-------|-------------|
| 13 | Service worker efímero | Estado no puede vivir en variables globales |
| 14 | `invalid_grant` | Falta lógica de limpieza de sesión y re-auth |

### Medios (afectan robustez o UX)
| # | Vacío | Descripción |
|---|-------|-------------|
| 3 | Header incorrecto | `X-Goog-Colab-Client-Agent` → `X-Colab-Client-Agent` |
| 5 | Manejo de errores | Faltan 412, `invalid_grant`, client changed |
| 9 | `subscriptionTier` | Campo nuevo útil para UX |
| 10 | `paidComputeUnitsBalance` opcional | Puede ser undefined en Free tier |
| 11 | Estructura de aceleradores | `{variant, models}` en vez de arrays planos |
| 15 | Timeout | Request sin timeout puede colgar el polling |

### Bajos (mejoras opcionales)
| # | Vacío | Descripción |
|---|-------|-------------|
| 4 | Redirect URI | `launchWebAuthFlow` es válido para Chrome |
| 6 | Balance máximo | Ahora inferible con `subscriptionTier` |
| 7 | Intervalo de polling | 1 min vs 5 min oficial; funcional pero agresivo |
| 12 | Prefijo XSSI | Manejo defensivo es correcto |

---

## Alternativas investigadas (resumen)

Para referencia, se investigaron enfoques alternativos que NO requieren OAuth2 propio:

### Enfoque B: Same-origin fetch desde content script
- Un content script en `colab.research.google.com` puede hacer `fetch()` same-origin con `credentials: 'include'` al endpoint `/tun/m/*` — las cookies de sesión se envían automáticamente
- Para el endpoint GAPI (cross-origin), el fetch debe delegarse al service worker
- El service worker puede leer cookies HttpOnly con `chrome.cookies.getAll()` (requiere permiso `cookies`)

### Enfoque de interceptación: MAIN world + fetch override
- Un script en `world: "MAIN"` puede sobrescribir `window.fetch` para interceptar los requests que la propia UI de Colab hace
- Comunica al content script via `window.postMessage`
- No genera requests adicionales al servidor

### Enfoque C: Lectura del DOM
- El panel "View Resources" muestra el balance, pero requiere navegar Shadow DOM abierto
- Los selectores exactos deben descubrirse empíricamente
- Más frágil ante cambios de UI

### `chrome.debugger`
- Puede capturar response bodies de cualquier request
- Muestra barra de advertencia naranja permanente — no práctico

### Evaluación rápida
| Enfoque | Necesita OAuth | Necesita Colab abierto | Robustez | Complejidad |
|---------|---------------|----------------------|----------|-------------|
| A (OAuth + GAPI) | Sí | No | Alta | Media |
| B (Same-origin fetch) | No | Sí | Media-alta | Baja |
| Interceptación (MAIN world) | No | Sí | Media | Media |
| C (DOM scraping) | No | Sí | Baja | Baja |
| Debugger | No | Sí | Alta | Alta (+ banner) |
