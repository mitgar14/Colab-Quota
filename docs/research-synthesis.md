# Colab Quota Extension — Síntesis de Investigación Fundacional

> Documento de referencia para la planificación del proyecto. Consolida hallazgos de 5 líneas de investigación paralelas.

---

## 1. Estado del Endpoint `ccu-info`

### Naturaleza del endpoint
El endpoint `GET https://colab.research.google.com/tun/m/ccu-info?authuser=0` es **interno y no documentado**. Pertenece al sistema de proxy inverso `/tun/m/` que Colab usa para enrutar tráfico entre el frontend y las instancias de cómputo. No existe documentación oficial de Google para este endpoint ni compromiso de estabilidad.

### Riesgo de ruptura
**ALTO.** Google ha modificado rutas internas de Colab sin aviso previo (documentado en múltiples issues de `googlecolab/colabtools`). La probabilidad de cambio sin notificación es significativa.

### Campos de la respuesta
Ninguna búsqueda encontró documentación oficial de los campos (`currentBalance`, `consumptionRateHourly`, `eligibleGpus`, `freeCcuQuotaInfo`). El conocimiento existente proviene de:
- Inspección directa con DevTools por usuarios
- El proyecto `xeodou/colab-cli` (CLI en Go con comando `colab quota`)
- Ingeniería inversa documentada por DagsHub (2022)

### Variaciones por tipo de cuenta (inferidas, no verificadas)
| Plan | `currentBalance` | `freeCcuQuotaInfo` | `eligibleGpus` |
|------|------------------|--------------------|----------------|
| Free | Presente | Poblado | T4 |
| Pro ($9.99/mes) | ~100 CU | Probable null | T4, V100 |
| Pro+ ($49.99/mes) | ~500 CU | Probable null | T4, V100, A100 |
| Pay-as-you-go | Variable | Probable null | Todos |

> **Vacío crítico**: La estructura exacta del JSON por tipo de cuenta solo puede verificarse empíricamente con cuentas reales de cada tier.

### Prefijo XSSI `)]}'\n`
Patrón **estándar de Google**, ampliamente documentado. Protege contra ataques de JSON hijacking. Usado en APIs internas de Google Workspace, Gerrit, Angular, etc. Su presencia es una firma confiable de un endpoint interno de Google.

### Rate limiting
**Sin documentación pública** para `ccu-info` específicamente. Google aplica rate limiting general (HTTP 429/403) en sus APIs. Polling cada 60 segundos es un patrón de uso bajo que probablemente sea seguro, pero no hay garantías. No existen reports públicos de bloqueos por polling moderado de este endpoint.

### Headers requeridos
| Header | Propósito | ¿Obligatorio? |
|--------|-----------|----------------|
| `Authorization: Bearer <token>` | Autenticación OAuth2 | Sí |
| `x-colab-tunnel: Google` | Protección anti-XSS del proxy | Probablemente sí (documentado por DagsHub) |
| `X-Goog-Colab-Client-Agent: vscode` | Identificación del cliente | Probablemente no obligatorio |

> **Descubrimiento**: El header `x-colab-tunnel: Google` (documentado por DagsHub) no aparece en el plan original pero es probablemente requerido por el proxy.

### Alternativas al endpoint
| Alternativa | Viabilidad |
|-------------|------------|
| Colab Enterprise REST API | No aplica — solo para GCP Enterprise, no cuentas personales |
| Cloud Quotas API | No aplica — para recursos GCP, no créditos Colab |
| `colab-cli` (xeodou) | Referencia técnica útil; usa el mismo endpoint internamente |
| Lectura del DOM del panel "View Resources" | Viable como alternativa sin OAuth |
| Interceptar requests internos de la UI | Viable pero frágil |

---

## 2. Autenticación OAuth2 y el Scope `colaboratory`

### Clasificación del scope
El scope `https://www.googleapis.com/auth/colaboratory` está clasificado como **RESTRINGIDO** por Google — el nivel más alto de restricción. Implicaciones:

- Apps con este scope quedan en modo "Testing", limitadas a **100 usuarios de prueba** que deben añadirse manualmente
- Para distribución pública: requiere verificación de app + auditoría de seguridad CASA por tercero aprobado (costo no trivial, renovación anual)
- **No aparece en la lista pública de scopes OAuth2 de Google** (`developers.google.com/identity/protocols/oauth2/scopes`)

### Viabilidad para distribución pública
**Extremadamente difícil.** Requiere:
1. Pasar la revisión de Chrome Web Store
2. Pasar la verificación de scopes restringidos de Google OAuth
3. Auditoría CASA (miles de dólares, renovación anual)
4. Google puede denegar la verificación si considera el scope "solo para uso interno"

### Estrategia de `colab-cli`
El proyecto `colab-cli` reutiliza las credenciales OAuth públicas de la extensión oficial de VS Code de Google (cuyo `client_id` es visible en el código fuente de `googlecolab/colab-vscode`). Esto evita la verificación pero:
- Viola los ToS de Google (uso indebido de credenciales de terceros)
- Google puede rotar esas credenciales en cualquier momento

### Alternativas de autenticación descubiertas

| Enfoque | Fricción técnica | Riesgo legal | Distribución |
|---------|-----------------|--------------|--------------|
| OAuth propio + scope `colaboratory` | Media | Medio | Imposible sin CASA |
| Reutilizar credenciales de colab-vscode | Baja | Alto | No recomendable |
| `chrome.identity.getAuthToken` | Baja | Medio | Mismo problema de scope |
| Cookies de sesión (content script + fetch same-origin) | **Muy baja** | Bajo | Viable |
| Interceptar token desde requests de la página | Baja | Medio | Frágil |
| Leer datos del DOM directamente | **Mínima** | **Mínimo** | **Más viable** |

### Riesgos legales y de ToS
- Los Google APIs ToS prohíben explícitamente: *"Reverse engineering undocumented Google API Services"*
- Hay precedentes de Google suspendiendo cuentas por uso no autorizado de la infraestructura de Colab (caso `colab-ssh`)
- Issues #4979, #4982, #4986, #5038 documentan bloqueos por "suspected abusive activity"
- Un polling cada 60s desde una extensión de Chrome legítima tiene riesgo BAJO, pero no cero

---

## 3. Arquitectura Chrome MV3

### Service Workers efímeros
- **Se duermen tras 30 segundos de inactividad** — las variables globales no persisten
- Un request que tarde >5 min termina el SW
- Un fetch() que tarde >30s en responder termina el SW

### `chrome.alarms` — Intervalos reales
| Contexto | Mínimo |
|----------|--------|
| Extensiones publicadas (Chrome 120+) | **30 segundos** |
| Extensiones publicadas (pre-Chrome 120) | 1 minuto |
| Extensiones no empaquetadas (dev mode) | Sin límite |

> **Descubrimiento**: El plan original asume 1 minuto, pero el mínimo real es 30 segundos desde Chrome 120.

### Almacenamiento
| API | Persistencia | Tamaño | Acceso content script | Uso recomendado |
|-----|-------------|--------|----------------------|-----------------|
| `chrome.storage.local` | Persiste entre reinicios de browser | ~10MB | Sí | Tokens, datos de quota |
| `chrome.storage.session` | Se borra al cerrar browser | ~10MB | Configurable | Estado temporal, flags |
| Variables globales | Se pierden al dormir el SW | N/A | No | Solo caché efímera |

### Comunicación SW ↔ Content Script
El patrón más robusto para este caso es:
```
Service Worker → escribe en chrome.storage.local
Content Script → escucha chrome.storage.onChanged → actualiza UI
```
- `chrome.storage.onChanged` es **confiable en content scripts**
- Evita problemas de "Receiving end does not exist" de `sendMessage`
- Evita la desconexión de `Port` tras 5 minutos de inactividad

### Patrón arquitectónico recomendado
```
[chrome.alarms] → despierta SW → lee estado de chrome.storage
                                → realiza fetch al endpoint
                                → escribe resultado en chrome.storage.local
                                → SW se duerme

[Content Script] → escucha chrome.storage.onChanged
                 → actualiza UI/DOM según nuevo estado
                 → si necesita acción inmediata: chrome.runtime.sendMessage al SW
```

### Riesgo de token refresh race
Documentado: si el SW se reinicia mientras otro contexto intenta refrescar el token, pueden ocurrir escrituras concurrentes en `chrome.storage` (no soporta transacciones). Solución: implementar un lock lógico o usar un flag "refresh en progreso" en `chrome.storage.session`.

### Offscreen Documents
Disponibles desde Chrome 109. Solo uno por extensión. Útiles para acceso DOM que el SW no tiene, pero **no recomendados como arquitectura principal**. Las técnicas keepalive con offscreen documents son workarounds no oficiales.

---

## 4. DOM de Google Colab

### Arquitectura frontend
- **SPA** basada en **Web Components** (Polymer/Lit) con custom elements prefijados `colab-*`
- **Shadow DOM en modo ABIERTO** — `.shadowRoot` accesible desde scripts externos
- Navegación interna via **History API** (no recarga la página)
- Iframes **cross-origin** (`notebooks.googleusercontent.com`) para outputs de celdas
- `X-Frame-Options: deny` en el dominio principal

### Componentes clave del DOM
| Selector | Elemento |
|----------|----------|
| `#top-toolbar` | Barra superior principal (estable, persistente) |
| `colab-connect-button` | Botón de conexión (dentro del toolbar) |
| `colab-toolbar-button` | Botones genéricos del toolbar |
| `colab-status-bar` | Barra de estado inferior |
| `colab-toolbar` | Barra con File, Edit, Runtime, etc. |

### Acceso al Shadow DOM (patrón confirmado por userscripts reales)
```javascript
document.querySelector("#top-toolbar > colab-connect-button")
  .shadowRoot
  .querySelector("#connect")
```
Si algún componente usa Shadow DOM cerrado: `chrome.dom.openOrClosedShadowRoot()` (Chrome 106+).

### Información de quota existente en la UI
- **"View Resources"** en el menú del avatar → barra lateral con balance de CU
- **No hay indicador siempre-visible** del balance en la UI principal
- **"Low balance warning"** aparece como banner cuando el balance es bajo
- La barra de estado inferior muestra RAM/GPU pero **NO** el balance de CU

> **Validación del producto**: La UI nativa de Colab no muestra el balance de forma prominente ni persistente, confirmando el nicho de la extensión.

### Desafíos de inyección de UI
| Desafío | Mitigación |
|---------|------------|
| CSP de la página | Content scripts están exentos de la CSP del host |
| Re-renders del DOM | `MutationObserver` para re-inyectar si se elimina el elemento |
| Navegación SPA | Interceptar History API o detectar cambios de URL |
| Z-index de modales de Colab | Usar z-index ≥ 9999 |
| Conflicto con ciclo de vida de componentes | Encapsular UI inyectada en Shadow DOM propio |

### Punto de anclaje recomendado
El selector `#top-toolbar` es el punto más estable para anclar un widget. Es persistente durante toda la sesión y accesible via query selector estándar.

---

## 5. Ecosistema Existente (Gap de Mercado)

### Extensiones de Chrome existentes
**No existe NINGUNA extensión que monitoree Compute Units de Colab.** Las extensiones existentes cubren:
- Keep-alive / anti-desconexión (Google Colab Keep-Alive, Colab Alive, Colab Autorun and Connect)
- Utilidades generales (Open in Colab, Colab Notifier, Visual Python, Side-by-Side)

### Herramientas relevantes
| Herramienta | Enfoque | Monitorea CU? |
|-------------|---------|---------------|
| `xeodou/colab-cli` | CLI con `colab quota` | Sí (único conocido) |
| `darien-schettler` (Gist) | Recursos físicos (CPU/GPU/RAM) | No |
| Userscripts (Greasy Fork) | Keep-alive | No |

### Pain points documentados de la comunidad
- **Falta de transparencia**: usuarios no pueden ver historial de consumo ni proyecciones
- **CU se consumen sin sesión activa** (Issue #3617)
- **Caducidad de CU a 90 días** descubierta tarde por usuarios
- **Balance incorrecto en la UI** (Issues #4338, #4668, #5072)
- **Sistema de créditos percibido como opaco y user-hostile** (discusiones HN)

> **Oportunidad confirmada**: Gap de producto real y validado por los pain points de la comunidad.

---

## 6. Análisis de Enfoques de Implementación

### Enfoque A: OAuth2 propio + endpoint `ccu-info` (Plan original)
**Pros:**
- Datos directos y estructurados del API
- No depende del DOM de Colab
- Polling periódico independiente del estado de la página

**Contras:**
- Scope `colaboratory` es RESTRINGIDO (100 usuarios max sin CASA)
- Imposible de distribuir públicamente sin auditoría costosa
- Requiere que el usuario configure credenciales OAuth en GCP
- Depende de un endpoint no documentado que puede cambiar
- Riesgo de ToS por acceso a API no documentada

### Enfoque B: Content script + cookies de sesión + fetch same-origin
**Pros:**
- No requiere OAuth2 propio: usa la sesión autenticada del usuario
- El content script en `colab.research.google.com` puede hacer `fetch()` al mismo origen
- Sin restricción de scope ni proceso de verificación
- Distribuible en Chrome Web Store sin problemas de scope

**Contras:**
- Funciona solo cuando el usuario tiene Colab abierto en una pestaña
- Las cookies HttpOnly no son accesibles desde JS, pero el `fetch()` same-origin las envía automáticamente
- Sigue dependiendo del endpoint no documentado `ccu-info`
- El header `x-colab-tunnel: Google` podría necesitarse

### Enfoque C: Content script + lectura directa del DOM
**Pros:**
- **Mínimo riesgo legal**: solo lee datos ya visibles en la UI
- No requiere autenticación adicional de ningún tipo
- No accede a endpoints no documentados
- Más fácil de publicar en Chrome Web Store
- No requiere permisos OAuth2 ni `identity`

**Contras:**
- Depende de la estructura del DOM de Colab (selectores `colab-*`)
- Shadow DOM puede dificultar la lectura de datos internos
- Requiere que el panel "View Resources" esté abierto o sea abierto programáticamente
- Menos datos disponibles que el endpoint (sin `eligibleGpus`, sin `freeCcuQuotaInfo`)
- Más frágil ante cambios de UI

### Enfoque D: Híbrido (B + C como fallback)
**Pros:**
- Combina la riqueza de datos del fetch same-origin con la resiliencia del DOM scraping
- Si el endpoint falla, puede intentar leer del DOM como fallback
- Máxima robustez ante cambios parciales

**Contras:**
- Mayor complejidad de implementación
- Necesita mantener dos estrategias de obtención de datos

### Evaluación comparativa

| Criterio | A (OAuth) | B (Same-origin fetch) | C (DOM) | D (Híbrido) |
|----------|-----------|----------------------|---------|-------------|
| Riqueza de datos | ★★★★★ | ★★★★★ | ★★☆☆☆ | ★★★★★ |
| Facilidad de setup para el usuario | ★☆☆☆☆ | ★★★★★ | ★★★★★ | ★★★★★ |
| Distribución pública | ★☆☆☆☆ | ★★★★☆ | ★★★★★ | ★★★★☆ |
| Riesgo legal | ★★☆☆☆ | ★★★☆☆ | ★★★★★ | ★★★☆☆ |
| Resiliencia ante cambios | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★☆ |
| Complejidad de implementación | ★★☆☆☆ | ★★★★☆ | ★★★★★ | ★★★☆☆ |
| Funciona sin Colab abierto | ★★★★★ | ☆☆☆☆☆ | ☆☆☆☆☆ | ☆☆☆☆☆ |

---

## 7. Vacíos y Preguntas Abiertas

### Verificación empírica necesaria
1. **Estructura exacta del JSON de `ccu-info`** por tipo de cuenta (Free, Pro, Pro+, PAYG)
2. **¿Es realmente necesario el header `x-colab-tunnel: Google`?** — Verificar con DevTools
3. **¿Funciona un `fetch()` same-origin desde content script** al endpoint `ccu-info`?
4. **CSP exacta de `colab.research.google.com`** — Verificar headers de respuesta con DevTools
5. **¿Qué selectores DOM usa el panel "View Resources"?** — Inspeccionar con DevTools
6. **¿Los iframes de Colab son same-origin o cross-origin?** — Verificar URLs en DevTools
7. **¿El `authuser` parámetro afecta la respuesta** cuando el usuario tiene múltiples cuentas Google?

### Decisiones arquitectónicas pendientes
1. **¿Enfoque A, B, C, o D?** — Impacta toda la arquitectura
2. **¿Uso personal vs distribución pública?** — Determina la viabilidad del Enfoque A
3. **¿`chrome.identity.getAuthToken` vs `launchWebAuthFlow`?** — Solo relevante si se elige Enfoque A
4. **¿Mínima versión de Chrome soportada?** — Chrome 120 para alarms de 30s
5. **¿Cómo determinar el balance máximo** para calcular porcentajes del borde? — Colab no expone este dato

### Riesgos técnicos identificados
1. **Endpoint `ccu-info` puede cambiar sin aviso** — Necesita manejo de errores robusto y versionado
2. **Token refresh race** con service workers efímeros — Necesita lock lógico
3. **Re-renders de Colab pueden eliminar UI inyectada** — Necesita `MutationObserver`
4. **Múltiples cuentas Google** — El parámetro `authuser` puede no ser suficiente
5. **Navegación SPA no dispara re-inyección** del content script — Necesita interceptar History API

---

## 8. Fuentes Principales

### Ingeniería inversa de Colab
- [Reverse Engineering Google Colab (DagsHub, 2022)](https://dagshub.com/blog/reverse-engineering-google-colab/)
- [Discusión en Hacker News](https://news.ycombinator.com/item?id=31851031)

### Referencia técnica
- [xeodou/colab-cli (GitHub)](https://github.com/xeodou/colab-cli) — Única herramienta OSS con `colab quota`
- [googlecolab/colab-vscode (GitHub)](https://github.com/googlecolab/colab-vscode) — Extensión oficial de VS Code
- [colabtools/auth.py (GitHub)](https://github.com/googlecolab/colabtools/blob/main/google/colab/auth.py)

### Documentación oficial Chrome MV3
- [Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [chrome.alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [chrome.identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Offscreen Documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)

### OAuth2 y ToS
- [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes)
- [Restricted Scope Verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google APIs Terms of Service](https://developers.google.com/terms)
- [Google Colab Additional ToS](https://colab.research.google.com/terms)

### Issues relevantes de colabtools
- [#3236: Consumed compute units](https://github.com/googlecolab/colabtools/issues/3236)
- [#3617: CU consumed without active runtime](https://github.com/googlecolab/colabtools/issues/3617)
- [#4338: Incorrect Compute Units](https://github.com/googlecolab/colabtools/issues/4338)
- [#5072: Colab Pro shows no CU (2025)](https://github.com/googlecolab/colabtools/issues/5072)
- [#5811: Shadow DOM hack for Gemini (2026)](https://github.com/googlecolab/colabtools/issues/5811)

### Extensiones y userscripts de referencia
- [Colab Autorun and Connect](https://github.com/tdulcet/Colab-Autorun-and-Connect)
- [Visual Python for Colab](https://chromewebstore.google.com/detail/visual-python-for-colab/ccmkpknjfagaldcgidgcipbpdipfopob)
- [Google Colab Stay Alive (Greasy Fork)](https://greasyfork.org/en/scripts/427068-google-colab-stay-alive)

### Consumo de CU
- [CU Consumption Comparison 2024](https://varlog.info/colab-credit-consumption-comparison-2024/)
- [CU Evaporating (HF Forums)](https://discuss.huggingface.co/t/google-colabs-compute-units-are-evaporating-periodically/91918)
