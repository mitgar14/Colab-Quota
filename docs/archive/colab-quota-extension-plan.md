# Colab Quota Border — Chromium Extension

> Plan de implementación detallado para Claude Code

---

## Contexto técnico

### Endpoint objetivo
```
GET https://colab.research.google.com/tun/m/ccu-info?authuser=0
```

### Headers requeridos
```
Accept: application/json
Authorization: Bearer <access_token>
X-Goog-Colab-Client-Agent: vscode
```

### Respuesta (con prefijo XSSI `)]}'\n` a remover antes de parsear)
```jsonc
{
  "currentBalance": 87.4,           // CUs restantes
  "consumptionRateHourly": 11.7,    // CU/hora del runtime activo
  "assignmentsCount": 1,            // sesiones activas
  "eligibleGpus": ["T4"],
  "ineligibleGpus": ["A100", "L4"],
  "eligibleTpus": [],
  "ineligibleTpus": [],
  "freeCcuQuotaInfo": {
    "remainingTokens": "1000",      // viene como string, parsear a número
    "nextRefillTimestampSec": 1740000000
  }
}
```

### OAuth2
- **Flow**: Authorization Code + PKCE (S256)
- **Scopes**: `profile email https://www.googleapis.com/auth/colaboratory`
- **Auth URL**: `https://accounts.google.com/o/oauth2/v2/auth`
- **Token URL**: `https://oauth2.googleapis.com/token`
- **Redirect URI**: `https://<EXTENSION_ID>.chromiumapp.org/` (generado por Chrome)
- **client_id / client_secret**: credenciales propias creadas en GCP
  - Tipo: **Desktop app** (el `client_secret` no es un secreto real en este tipo)

---

## Estructura de archivos

```
colab-quota-extension/
│
├── manifest.json
│
├── background/
│   └── service-worker.js      # Auth, polling, storage
│
├── content/
│   ├── overlay.js             # Borde + widget + panel
│   └── overlay.css            # Estilos del overlay (inyectado)
│
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
│
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## Archivo: `manifest.json`

**Manifest Version**: 3

```jsonc
{
  "manifest_version": 3,
  "name": "Colab Quota Monitor",
  "version": "1.0.0",
  "description": "Muestra el balance de Compute Units de Colab en tiempo real.",

  "permissions": [
    "identity",    // chrome.identity para OAuth2
    "storage",     // chrome.storage.local: tokens + datos ccu
    "alarms"       // polling cada 1 minuto
  ],

  "host_permissions": [
    "https://colab.research.google.com/*",
    "https://oauth2.googleapis.com/*"
  ],

  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },

  "content_scripts": [{
    "matches": ["https://colab.research.google.com/*"],
    "js": ["content/overlay.js"],
    "css": ["content/overlay.css"],
    "run_at": "document_idle",
    "all_frames": false        // Solo top-level frame, ignorar iframes de Colab
  }],

  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": { "16": "icons/icon-16.png", "48": "icons/icon-48.png" }
  },

  "oauth2": {
    "client_id": "__REEMPLAZAR_CON_TU_CLIENT_ID__",
    "scopes": [
      "profile",
      "email",
      "https://www.googleapis.com/auth/colaboratory"
    ]
  }
}
```

> **Nota**: El campo `oauth2` en el manifest es opcional pero documentar los scopes
> aquí ayuda. El flujo real lo maneja `chrome.identity.launchWebAuthFlow` manualmente
> para poder usar PKCE correctamente.

---

## Archivo: `background/service-worker.js`

### Responsabilidades
1. Gestionar el ciclo de vida de tokens OAuth2 (auth inicial, refresh, logout)
2. Hacer polling al endpoint `/tun/m/ccu-info` cada 1 minuto via `chrome.alarms`
3. Persistir datos en `chrome.storage.local`
4. Responder mensajes del content script y popup

### Constantes necesarias
```javascript
const CLIENT_ID     = '__REEMPLAZAR__';
const CLIENT_SECRET = '__REEMPLAZAR__';
const AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const CCU_ENDPOINT  = 'https://colab.research.google.com/tun/m/ccu-info';
const XSSI_PREFIX   = ")]}'\n";
const ALARM_NAME    = 'colab-quota-poll';
```

### Storage schema (`chrome.storage.local`)
```javascript
{
  // Tokens OAuth2
  "tokens": {
    "access_token":  string,
    "refresh_token": string,
    "expires_at":    number   // unix timestamp ms
  },

  // Datos de quota
  "ccuInfo": {
    "currentBalance":       number,
    "consumptionRateHourly": number,
    "assignmentsCount":     number,
    "eligibleGpus":         string[],
    "ineligibleGpus":       string[],
    "eligibleTpus":         string[],
    "ineligibleTpus":       string[],
    "freeCcuQuotaInfo": {
      "remainingTokens":        number,
      "nextRefillTimestampSec": number
    } | null
  } | null,

  // Metadata
  "lastUpdated": number,   // unix timestamp ms
  "lastError":   string | null
}
```

### Máquina de estados interna
```
UNAUTHENTICATED  →  (login)  →  ACTIVE
     ↑                              │
     └──── (logout / error 401) ────┘
                                    │
                              cada 1 min: fetch
                              401 → REFRESHING → ACTIVE
                              error red → guarda lastError
```

### Funciones a implementar

#### `generatePKCE()`
- Genera `code_verifier` (random 64 bytes, base64url)
- Genera `code_challenge` (SHA-256 del verifier, base64url sin padding)
- Retorna `{ codeVerifier, codeChallenge }`

#### `buildAuthURL(codeChallenge)`
- Construye la URL de autorización con todos los parámetros PKCE
- `response_type: "code"`, `access_type: "offline"`, `prompt: "consent"`
- `code_challenge_method: "S256"`
- `redirect_uri`: `https://${chrome.runtime.id}.chromiumapp.org/`

#### `authenticate()`
- Llama `chrome.identity.launchWebAuthFlow({ url, interactive: true })`
- Extrae el `code` del `redirectUrl` resultante
- Llama `exchangeCodeForTokens(code, codeVerifier)`
- Guarda tokens en storage
- Registra el alarm de polling

#### `exchangeCodeForTokens(code, codeVerifier)`
- `POST` a `TOKEN_URL` con `grant_type: "authorization_code"`
- Retorna `{ access_token, refresh_token, expires_in }`
- Calcula y añade `expires_at = Date.now() + expires_in * 1000`

#### `refreshTokens(refreshToken)`
- `POST` a `TOKEN_URL` con `grant_type: "refresh_token"`
- Actualiza storage con nuevos tokens
- Preserva el `refresh_token` si Google no devuelve uno nuevo

#### `getValidAccessToken()`
- Lee tokens de storage
- Si `expires_at - 60_000 < Date.now()` → llama `refreshTokens()`
- Retorna `access_token` válido
- Lanza error si no hay tokens (usuario no autenticado)

#### `fetchCcuInfo()`
- Llama `getValidAccessToken()`
- `GET CCU_ENDPOINT?authuser=0` con headers correctos
- Si 401 → intenta refresh una vez, reintenta
- Remueve prefijo XSSI: `text.startsWith(XSSI_PREFIX) ? text.slice(XSSI_PREFIX.length) : text`
- Parsea JSON, castea `remainingTokens` string → number
- Guarda `ccuInfo` y `lastUpdated` en storage
- Guarda `lastError: null` en storage si éxito

#### `logout()`
- Limpia tokens y ccuInfo de storage
- Cancela el alarm
- Revoca el token en `https://oauth2.googleapis.com/revoke?token=<access_token>`

### Event listeners

```javascript
// Arranque del service worker
chrome.runtime.onInstalled.addListener(init)
chrome.runtime.onStartup.addListener(init)

// Polling
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchCcuInfo()
})

// Mensajes desde content script y popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'LOGIN':          authenticate().then(...)
    case 'LOGOUT':         logout().then(...)
    case 'REFRESH_NOW':    fetchCcuInfo().then(...)
    case 'GET_STATE':      sendResponse(buildStateSnapshot())
  }
})
```

---

## Archivo: `content/overlay.js`

### Responsabilidades
1. Inyectar el borde dinámico en `document.body`
2. Inyectar el widget flotante (chip) con el balance
3. Manejar hover → tooltip
4. Manejar click → panel lateral
5. Reaccionar a cambios en `chrome.storage.local` en tiempo real

### Elementos DOM a crear (todos `position: fixed`, `z-index: 999999`)

#### `#colab-quota-border`
```
position: fixed
top: 0, left: 0
width: 4px
height: 100vh
background: <color dinámico>
transition: background 0.5s ease
pointer-events: none   // no interfiere con clics en Colab
```

#### `#colab-quota-chip`
```
position: fixed
bottom: 24px
left: 12px
background: rgba(0,0,0,0.75)
color: white
border-radius: 8px
padding: 6px 10px
font-size: 12px
cursor: pointer
backdrop-filter: blur(4px)
```
Contenido: `⚡ 87.4 CU`

#### `#colab-quota-tooltip`
- Aparece en hover sobre el chip
- `position: fixed`, anclado sobre el chip
- Contenido:
  ```
  ⚡ 87.4 CU restantes
  ▼ 11.7 CU/hr  (~7h 28m)
  🟢 T4 disponible
  Actualizado hace 2 min
  ```

#### `#colab-quota-panel`
- Aparece al hacer click en el chip
- Panel lateral derecho: `position: fixed`, `right: 0`, `top: 0`, `height: 100vh`
- `width: 280px`
- Overlay semitransparente detrás para cerrar al click externo
- Contenido: ver sección UX más abajo

### Lógica de color del borde

```javascript
function getBalanceColor(balance, maxEstimated) {
  // maxEstimated: se puede estimar o usar un valor fijo de referencia (ej: 100 CU)
  const pct = (balance / maxEstimated) * 100
  if (pct > 60)  return '#22c55e'  // verde
  if (pct > 30)  return '#eab308'  // amarillo
  if (pct > 0)   return '#ef4444'  // rojo
  return '#ef4444'                  // rojo pulsante (agotado — ver animación)
}
```

> **Problema conocido**: Colab no expone el balance máximo. Estrategia: usar el
> primer valor observado como referencia, o permitir que el usuario configure
> su máximo en el popup.

### Estados del overlay según balance

```
balance > 0
  pct > 60%  →  borde verde sólido
  pct 30-60% →  borde amarillo sólido
  pct < 30%  →  borde rojo sólido

balance === 0, REFILL_PENDING
             →  borde rojo pulsante + chip con countdown

balance === 0, NO_REFILL
             →  borde rojo pulsante + chip con enlace de compra
```

Animación CSS para borde pulsante:
```css
@keyframes colab-quota-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}
#colab-quota-border.exhausted {
  animation: colab-quota-pulse 1.5s ease-in-out infinite;
}
```

### Lógica de tiempo estimado

```javascript
function estimateHoursRemaining(balance, rateHourly) {
  if (!rateHourly || rateHourly === 0) return null
  return balance / rateHourly  // horas
}

function formatDuration(hours) {
  if (hours === null) return '—'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`
}
```

### Estado: CUs agotados

El API no expone el tier del usuario directamente. La lógica para distinguir los dos
casos posibles se infiere de los campos disponibles:

```javascript
function getExhaustedState(ccuInfo) {
  if (ccuInfo.currentBalance > 0) return null  // no agotado

  const refill = ccuInfo.freeCcuQuotaInfo?.nextRefillTimestampSec

  if (refill && refill * 1000 > Date.now()) {
    return { type: 'REFILL_PENDING', refillAt: refill * 1000 }
  }

  return { type: 'NO_REFILL' }  // Pro/Pay-as-you-go sin regeneración automática
}
```

| `currentBalance` | `nextRefillTimestampSec` | Estado inferido | Acción en UI |
|---|---|---|---|
| `0` | futuro válido | Free — quota en cooldown | Cuenta regresiva |
| `0` | pasado / ausente | Pro/PAYG agotado | Enlace a compra |

#### Cuenta regresiva (`REFILL_PENDING`)

Se ejecuta **en el content script** con `setInterval` cada segundo, calculando
sobre el `refillAt` guardado en storage — no requiere llamadas adicionales al API:

```javascript
function formatCountdown(refillAtMs) {
  const diff = Math.max(0, refillAtMs - Date.now())
  const h    = Math.floor(diff / 3_600_000)
  const m    = Math.floor((diff % 3_600_000) / 60_000)
  const s    = Math.floor((diff % 60_000) / 1_000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}
```

El intervalo se limpia cuando el overlay detecta que `currentBalance > 0` en el
siguiente poll (el refill ya ocurrió).

#### UI para cada caso

**Borde**: rojo pulsante (`@keyframes pulse`) en ambos casos cuando `balance === 0`.

**Chip:**
```
// REFILL_PENDING
⛔ 0 CU — refill en 04:23:15

// NO_REFILL
⛔ 0 CU — sin unidades
```

**Tooltip en hover:**
```
// REFILL_PENDING                    // NO_REFILL
┌──────────────────────────┐        ┌──────────────────────────┐
│ ⛔ Compute Units agotados│        │ ⛔ Compute Units agotados│
│                          │        │                          │
│ Próximo refill           │        │ No hay regeneración      │
│ 12 Mar 2026 — 03:00      │        │ automática para este     │
│ ⏳ en 04:23:15           │        │ plan.                    │
└──────────────────────────┘        └──────────────────────────┘
```

**Panel lateral cuando `balance === 0`:**
```
┌────────────────────────────────┐
│ Colab Quota Monitor  [×][⟳]   │
├────────────────────────────────┤
│ ⛔ Balance            0.0 CU  │
│    Sesiones activas        0  │
├────────────────────────────────┤
│                                │
│  [REFILL_PENDING]              │
│  Quota se regenera en:         │
│  ┌──────────────────────────┐  │
│  │      04 : 23 : 15        │  ← countdown en tiempo real
│  └──────────────────────────┘  │
│  12 Mar 2026 — 03:00 (local)   │
│                                │
│  [NO_REFILL]                   │
│  Este plan no tiene            │
│  regeneración automática.      │
│  [→ Comprar Compute Units]     │  ← enlace a colab.research.google.com/signup
│                                │
├────────────────────────────────┤
│ [canvas: histórico 60 min]     │
└────────────────────────────────┘
```

> **Limitación conocida**: `nextRefillTimestampSec` pertenece a `freeCcuQuotaInfo`,
> que solo refleja la quota gratuita base del sistema. Para usuarios Pro/Pro+, la
> renovación mensual del balance comprado no está expuesta en este endpoint — la
> extensión no puede mostrar esa fecha.

### `chrome.storage.onChanged` listener
```javascript
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.ccuInfo || changes.lastUpdated) {
    updateOverlay(changes.ccuInfo?.newValue)
  }
})
```

### Panel lateral — contenido detallado

```
┌─────────────────────────────┐
│ Colab Quota Monitor  [×][⟳] │  ← [×] cierra, [⟳] refresh manual
├─────────────────────────────┤
│ Balance         87.4 CU     │
│ Consumo      11.7 CU/hr     │
│ Tiempo est.     ~7h 28m     │
│ Sesiones activas         1  │
├─────────────────────────────┤
│ GPU                         │
│  ✅ T4                      │
│  ❌ A100   ❌ L4            │
├─────────────────────────────┤
│ Quota gratuita              │
│  1,000 tokens               │
│  Refill: 12 Mar 2026 03:00  │
├─────────────────────────────┤
│ [canvas: histórico 60 min]  │  ← sparkline de balance
└─────────────────────────────┘
│ Actualizado: hace 45s       │
```

### Histórico (sparkline)
- Array circular en `chrome.storage.local`: últimas 60 entradas (= 60 min)
- Cada entrada: `{ ts: number, balance: number }`
- `canvas` 260×60px, línea blanca sobre fondo oscuro
- Se añade un punto en cada poll exitoso

---

## Archivo: `popup/popup.html` + `popup.js`

### Estado: No autenticado
```
┌────────────────────────────┐
│  🔵 Colab Quota Monitor    │
│                            │
│  Conecta tu cuenta Google  │
│  para ver tus Compute      │
│  Units en tiempo real.     │
│                            │
│  [  Conectar con Google  ] │
└────────────────────────────┘
```

### Estado: Autenticado
```
┌────────────────────────────┐
│  🟢 Conectado              │
│  usuario@gmail.com         │
│                            │
│  Balance:      87.4 CU     │
│  Actualizado: hace 45s     │
│                            │
│  [  Actualizar ahora  ]    │
│  [  Desconectar       ]    │
└────────────────────────────┘
```

### Estado: Error
```
┌────────────────────────────┐
│  🔴 Error de conexión      │
│                            │
│  No se pudo obtener datos. │
│  <mensaje de error>        │
│                            │
│  [  Reintentar  ]          │
└────────────────────────────┘
```

---

## Setup inicial para el usuario (README)

1. Crear credenciales OAuth2 en [GCP Console](https://console.cloud.google.com/apis/credentials)
   - Tipo: **Desktop app**
   - Añadir redirect URI: `https://<EXTENSION_ID>.chromiumapp.org/`
   - El `EXTENSION_ID` se obtiene tras cargar la extensión en `chrome://extensions`
2. Reemplazar `CLIENT_ID` y `CLIENT_SECRET` en `background/service-worker.js`
3. Cargar la extensión en modo desarrollador: `chrome://extensions` → "Cargar descomprimida"
4. Click en el ícono de la extensión → "Conectar con Google"

---

## Consideraciones de implementación

### Seguridad
- `CLIENT_SECRET` va en el service worker (no en content script). Para una extensión personal no es un problema — en apps de escritorio OAuth2 el secret no es realmente secreto.
- Los tokens se guardan en `chrome.storage.local` (no `sync` para no exponerlos a la nube).
- El content script nunca tiene acceso directo a los tokens — solo al `ccuInfo` ya procesado.

### Manejo de errores
- **401**: refresh inmediato; si falla el refresh → marcar como `UNAUTHENTICATED`
- **429 / 5xx**: backoff exponencial (implementar contador en storage)
- **Sin runtime activo** (`consumptionRateHourly === 0`): mostrar chip en gris con `— CU/hr`
- **ccuInfo === null**: chip muestra `---` sin romper la UI

### Edge cases a cubrir
- Colab abre varios iframes → `all_frames: false` en manifest previene duplicados
- El service worker puede dormir entre polls → `chrome.alarms` lo despierta correctamente
- El usuario abre múltiples tabs de Colab → el overlay se inyecta en cada tab pero
  comparten el mismo storage, por lo que todos ven los mismos datos
- Primera carga sin datos todavía → chip en estado skeleton/loading
- **CUs en 0 con refill pendiente** → `setInterval` de 1s para el countdown;
  limpiar el intervalo cuando el siguiente poll detecte `balance > 0`
- **Refill ya ocurrió pero el poll aún no corrió** → el countdown llega a `00:00:00`
  sin crashear; espera pasivamente al siguiente tick del alarm

---

## Orden de implementación sugerido para Claude Code

```
Fase 1 — Core auth + fetch
  [ ] manifest.json
  [ ] background/service-worker.js
        - PKCE helpers
        - authenticate()
        - fetchCcuInfo()
        - chrome.alarms polling (1 min)
        - onMessage handler

Fase 2 — Overlay básico
  [ ] content/overlay.css
  [ ] content/overlay.js
        - borde dinámico
        - chip con balance
        - chrome.storage.onChanged listener

Fase 3 — Interactividad
  [ ] Tooltip en hover
  [ ] Panel lateral en click
        - datos completos
        - botón refresh manual

Fase 4 — Histórico
  [ ] Circular buffer en storage
  [ ] Sparkline canvas en el panel

Fase 5 — Popup
  [ ] popup.html / popup.js
        - estados: unauth / active / error
        - botones login / logout / refresh

Fase 6 — Polish
  [ ] Animación de borde pulsante cuando balance === 0 (CSS @keyframes)
  [ ] Countdown en tiempo real para REFILL_PENDING (setInterval 1s)
  [ ] Enlace de compra para NO_REFILL
  [ ] Formateo de fechas localizado
  [ ] Icono dinámico de la extensión según % (chrome.action.setIcon)
```
