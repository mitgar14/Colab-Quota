# Colab Quota — Design Document

> Extension de navegador Chromium (Chrome/Edge/Brave) para monitorear Compute Units de Google Colab en tiempo real.

**Fecha:** 2026-03-01
**Alcance:** Uso personal, 2-4 usuarios
**Enfoque:** OAuth2 PKCE + endpoint GAPI

---

## Decisiones de diseno

| Decision | Resultado |
|----------|-----------|
| Credenciales OAuth | Propias en GCP Console (Desktop App) |
| UI v1 | Chip flotante + tooltip (sin borde lateral, sin panel) |
| Countdown de refill | Incluido en v1 |
| Build tools | Vanilla JS puro, sin bundler |
| Popup | Auth + balance basico |
| Browsers | Chromium-based (Chrome + Edge + Brave) |
| Enfoque de datos | OAuth2 PKCE + endpoint GAPI (Enfoque A) |

---

## 1. Arquitectura general

### Estructura de archivos

```
colab-quota-extension/
├── manifest.json
├── background/
│   └── service-worker.js       # Auth OAuth2, polling, storage
├── content/
│   ├── overlay.js              # Chip flotante + tooltip + countdown
│   └── overlay.css             # Estilos del overlay
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

### Flujo de datos

```
┌─────────────────────┐     chrome.alarms      ┌───────────────────────┐
│   Google OAuth2      │<──── cada 5 min ───────│   Service Worker      │
│   (consent screen)   │                        │                       │
└─────────────────────┘     GET /v1/user-info   │  - OAuth2 PKCE        │
                            ┌───────────────┐   │  - Token management   │
                            │ colab.pa.     │<──│  - Fetch ccu-info     │
                            │ googleapis.com│   │  - Write to storage   │
                            └───────────────┘   └───────────┬───────────┘
                                                            │
                                                   chrome.storage.local
                                                            │
                                        ┌───────────────────┼──────────────────┐
                                        v                                      v
                              ┌──────────────────┐                  ┌──────────────────┐
                              │  Content Script   │                  │     Popup         │
                              │  (overlay.js)     │                  │  (popup.js)       │
                              │                   │                  │                   │
                              │  - Chip flotante  │                  │  - Login/Logout   │
                              │  - Tooltip        │                  │  - Balance actual  │
                              │  - Countdown      │                  │  - Actualizar     │
                              └──────────────────┘                  └──────────────────┘
```

### Comunicacion entre componentes

- **SW -> Content Script / Popup:** via `chrome.storage.local` + `storage.onChanged`
- **Content Script / Popup -> SW:** via `chrome.runtime.sendMessage` (LOGIN, LOGOUT, REFRESH_NOW)
- El SW nunca necesita saber que tabs estan abiertas; storage es el canal compartido

---

## 2. Autenticacion OAuth2

### Flujo completo

```
Usuario click "Conectar" en popup
  -> SW genera PKCE (code_verifier + code_challenge S256)
  -> SW llama chrome.identity.launchWebAuthFlow({url, interactive: true})
  -> Browser abre ventana de consent de Google
  -> Usuario autoriza (pantalla "app no verificada" -> Avanzado -> Continuar)
  -> Google redirige a https://<EXTENSION_ID>.chromiumapp.org/?code=XXX
  -> SW extrae code del redirect URL
  -> SW POST a https://oauth2.googleapis.com/token
      (grant_type=authorization_code, code, code_verifier, client_id, client_secret, redirect_uri)
  -> Recibe { access_token, refresh_token, expires_in }
  -> Calcula expires_at = Date.now() + expires_in * 1000
  -> Guarda en chrome.storage.local
  -> Registra chrome.alarm de polling
  -> Hace primer fetch de quota inmediatamente
```

### Scopes

```
profile
email
https://www.googleapis.com/auth/colaboratory
```

### Refresh de tokens

- Antes de cada fetch: si `expires_at - 300_000 < Date.now()` (5 min de margen) -> refresh
- POST a token endpoint con `grant_type=refresh_token`
- Si `invalid_grant` (400) -> limpiar sesion completa, marcar como UNAUTHENTICATED
- Si 401 en refresh -> limpiar sesion (client_id cambio o fue revocado)
- Preservar `refresh_token` existente si Google no devuelve uno nuevo

### Storage schema — tokens

```javascript
{
  "tokens": {
    "access_token":  string,
    "refresh_token": string,
    "expires_at":    number     // unix timestamp ms
  },
  "userInfo": {
    "name":  string,
    "email": string
  }
}
```

### Compatibilidad Chromium-based

`launchWebAuthFlow` funciona en Chrome, Edge y Brave. La redirect URI `https://<ID>.chromiumapp.org/` es generada por el runtime de cada navegador.

---

## 3. Polling y obtencion de datos

### Endpoint

```
GET https://colab.pa.googleapis.com/v1/user-info?get_ccu_consumption_info=true
```

### Headers

```
Accept: application/json
Authorization: Bearer <access_token>
X-Colab-Client-Agent: vscode
```

### Respuesta — transformaciones

| Campo API | Tipo real | Transformacion | Campo interno |
|-----------|----------|----------------|---------------|
| `subscriptionTier` | string enum (`SUBSCRIPTION_TIER_*`) | Mapear a `"free"`, `"pro"`, `"pro_plus"` | `tier` |
| `paidComputeUnitsBalance` | number | Ninguna | `paidBalance` |
| `consumptionRateHourly` | number | Ninguna | `burnRate` |
| `assignmentsCount` | number | Ninguna | `activeSessions` |
| `eligibleAccelerators` | `[{variant, models}]` | Aplanar a `{gpus: [], tpus: []}` | `eligible` |
| `ineligibleAccelerators` | `[{variant, models}]` | Aplanar igual | `ineligible` |
| `freeCcuQuotaInfo.remainingTokens` | string | `Number(val) / 1000` -> CCU | `freeBalance` |
| `freeCcuQuotaInfo.nextRefillTimestampSec` | number | `* 1000` -> ms | `refillAt` |

### Prefijo XSSI

Manejo defensivo: si la respuesta empieza con `)]}'\n`, cortarlo antes de `JSON.parse`.

### Polling

- `chrome.alarms` con `periodInMinutes: 5` (alineado con la extension oficial)
- Alarm registrado en `onInstalled` + `onStartup` + despues de login exitoso
- Listener de `onAlarm` registrado en el nivel superior del SW (no dentro de callbacks)

### Manejo de errores

| Situacion | Accion |
|-----------|--------|
| 401 | Intentar refresh del token -> reintentar 1 vez -> si falla, UNAUTHENTICATED |
| `invalid_grant` (400 en refresh) | Limpiar sesion, marcar UNAUTHENTICATED |
| 429 / 5xx | Guardar `lastError`, no reintentar hasta siguiente alarm |
| Network error | Guardar `lastError`, no reintentar |
| Timeout (10s) | AbortController, guardar `lastError` |

### Storage schema — datos de quota

```javascript
{
  "ccuInfo": {
    "tier":           "free" | "pro" | "pro_plus",
    "paidBalance":    number,
    "freeBalance":    number,        // ya convertido de milli-CCU
    "burnRate":       number,
    "activeSessions": number,
    "eligible":       { "gpus": string[], "tpus": string[] },
    "ineligible":     { "gpus": string[], "tpus": string[] },
    "refillAt":       number | null  // unix timestamp ms
  } | null,
  "lastUpdated": number,             // unix timestamp ms
  "lastError":   string | null
}
```

### Reconstruccion de estado al despertar el SW

Cada vez que el alarm dispara, el SW lee tokens y estado desde `chrome.storage.local`. No depende de variables globales. El unico estado en memoria es transitorio durante la ejecucion del fetch.

---

## 4. Content Script — Chip + Tooltip + Countdown

### Inyeccion

Solo en `https://colab.research.google.com/*`, `run_at: "document_idle"`, `all_frames: false`.

### Chip flotante (`#cq-chip`)

- `position: fixed`, `bottom: 24px`, `left: 12px`, `z-index: 99999`
- Balance total = `paidBalance + freeBalance`
- Estados visuales:

| Estado | Contenido del chip |
|--------|--------------------|
| Cargando (sin datos aun) | `-- CU` con skeleton pulse |
| Balance > 60% estimado | Balance en estilo "ok" |
| Balance 30-60% | Balance en estilo "warning" |
| Balance < 30% | Balance en estilo "danger" |
| Balance = 0 + refill pendiente | `0 CU — refill en HH:MM:SS` |
| Balance = 0 + sin refill | `0 CU — sin unidades` |
| No autenticado | `Colab Quota — conectar` (clickable, abre popup) |
| Error | `CU — error` con indicador |

### Estimacion de % para colores

Heuristica por tier (Colab no expone el balance maximo):

| Tier | Max estimado |
|------|-------------|
| Free | Basado en `freeBalance` inicial o 100 CU |
| Pro | 100 CU |
| Pro+ | 500 CU |

Si `paidBalance` observado es mayor al max del tier, ajustar dinamicamente.

### Tooltip (`#cq-tooltip`)

Aparece en `mouseenter` sobre el chip, desaparece en `mouseleave`. `position: fixed`, anclado encima del chip.

Contenido:

```
Balance         42.3 CU
Consumo         1.96 CU/hr
Tiempo est.     ~21h 35m
Sesiones        1

GPU  T4  L4  x A100
Plan Pro

Actualizado hace 2 min
```

### Countdown (balance = 0 con refill pendiente)

- `setInterval` cada 1 segundo en el content script
- Calcula `refillAt - Date.now()` y formatea como `HH:MM:SS`
- Se limpia cuando el siguiente poll detecta `balance > 0` (via `storage.onChanged`)
- Si llega a `00:00:00`, muestra `refill inminente...` sin crash

### Ciclo de vida del overlay

- `storage.onChanged` listener actualiza chip/tooltip reactivamente
- `MutationObserver` en `document.body` para re-inyectar si Colab elimina los elementos
- Elementos inyectados encapsulados en **Shadow DOM propio** para aislar estilos
- Navegacion SPA: los elementos `position: fixed` sobreviven a cambios de ruta internos; el `MutationObserver` maneja re-renders

---

## 5. Popup

### Tres estados

**No autenticado:**
- Mensaje de bienvenida
- Boton "Conectar con Google"

**Autenticado:**
- Email del usuario + badge de tier
- Balance actual (grande, prominente)
- Burn rate + tiempo estimado
- Timestamp de ultima actualizacion
- Botones "Actualizar" y "Salir"

**Error:**
- Mensaje de error breve
- Boton "Reintentar"

### Logica

- Al abrir: lee `tokens`, `ccuInfo`, `lastUpdated`, `lastError` de `chrome.storage.local`
- Sin tokens -> Estado 1
- Tokens + `lastError` -> Estado 3
- Tokens + `ccuInfo` -> Estado 2
- Escucha `storage.onChanged` para actualizar en tiempo real

### Mensajes al SW

- "Conectar" -> `{ type: 'LOGIN' }`
- "Actualizar" -> `{ type: 'REFRESH_NOW' }`
- "Salir" -> `{ type: 'LOGOUT' }`

### Dimensiones

~320px ancho, altura dinamica.

---

## 6. Manifest

```jsonc
{
  "manifest_version": 3,
  "name": "Colab Quota",
  "version": "1.0.0",
  "description": "Monitor de Compute Units de Google Colab en tiempo real.",
  "minimum_chrome_version": "120",

  "permissions": [
    "identity",
    "storage",
    "alarms"
  ],

  "host_permissions": [
    "https://colab.research.google.com/*",
    "https://colab.pa.googleapis.com/*",
    "https://oauth2.googleapis.com/*"
  ],

  "background": {
    "service_worker": "background/service-worker.js"
  },

  "content_scripts": [{
    "matches": ["https://colab.research.google.com/*"],
    "js": ["content/overlay.js"],
    "css": ["content/overlay.css"],
    "run_at": "document_idle",
    "all_frames": false
  }],

  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  }
}
```

Notas:
- `minimum_chrome_version: "120"` para `chrome.alarms` de 30s y features MV3 recientes
- Sin `"type": "module"` en el SW para maxima compatibilidad Chromium-based
- Sin seccion `oauth2` en manifest; el flujo se maneja con `launchWebAuthFlow`
- No se necesita `cookies` ni `webRequest`

---

## 7. Fuera de alcance (v1)

- Borde lateral coloreado
- Panel lateral desplegable
- Sparkline de historico
- Notificaciones de escritorio
- Icono dinamico segun % de balance
- Configuracion de intervalo de polling
- Soporte Firefox (usa `browser.*` en vez de `chrome.*`)

---

## 8. Referencia tecnica

Fuente autoritativa: `googlecolab/colab-vscode` (Apache-2.0, mantenido por Google LLC)

| Archivo | Contenido relevante |
|---------|-------------------|
| `src/colab/api.ts` | Schema Zod completo de la respuesta |
| `src/colab/client.ts` | Implementacion del cliente HTTP, XSSI, reintentos |
| `src/colab/headers.ts` | Definicion de todos los headers |
| `src/colab/consumption/notifier.ts` | Conversion milli-CCU -> CCU, umbrales |
| `src/colab/consumption/poller.ts` | Polling cada 5 minutos |
| `src/auth/auth-provider.ts` | Scopes, refresh, invalid_grant |
| `src/auth/flows/flows.ts` | Parametros PKCE de la URL de auth |
