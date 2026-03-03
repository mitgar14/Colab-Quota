# Colab Quota

Extensión de Chromium que muestra el consumo de Compute Units de Google Colab directamente en el navegador. Soporta múltiples cuentas de Google con detección automática de la cuenta activa en la página de Colab.

<!-- TODO: Reemplazar con captura o GIF real -->
<!-- ![Colab Quota en acción](assets/demo.gif) -->

## Tabla de contenidos

- [Qué hace](#qué-hace)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Uso](#uso)
- [Multi-cuenta](#multi-cuenta)
- [Arquitectura](#arquitectura)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Permisos](#permisos)
- [Privacidad](#privacidad)
- [Notas técnicas](#notas-técnicas)
- [Limitaciones](#limitaciones)
- [Licencia](#licencia)

## Qué hace

La extensión consulta periódicamente el endpoint de Google Colab para obtener información de consumo de Compute Units (CU) y la presenta en dos lugares:

- **Popup**: al hacer click en el icono de la extensión, muestra el saldo total, tasa de consumo, tiempo estimado restante, sesiones activas (CPU/GPU) y plan. Incluye countdown de refill cuando el saldo se agota, y tooltip con GPUs disponibles al pasar sobre el badge del plan. Permite agregar múltiples cuentas y cambiar entre ellas.
- **Overlay en Colab**: un chip flotante en la esquina inferior izquierda de `colab.research.google.com` que indica el saldo y consumo en tiempo real. Cambia de color según el nivel de saldo (verde, ámbar, rojo) y muestra una cuenta regresiva cuando las unidades se agotan. Detecta automáticamente qué cuenta de Google está activa en la página y muestra su cuota correspondiente.

Los datos se actualizan cada minuto mediante `chrome.alarms`. No hay servidor intermedio: la extensión habla directamente con las APIs de Google.

## Requisitos

- Google Chrome o navegador Chromium >= 120
- Una cuenta de Google con acceso a Colab

## Instalación

No hay build, bundler ni dependencias npm. La extensión se carga directamente.

### 1. Clonar el repositorio

```bash
git clone https://github.com/mitgar14/Colab-Quota.git
```

### 2. Cargar en Chrome

1. Abrir `chrome://extensions/` o pestaña de "Administrar extensiones" dentro del desplegable de Extensiones (pieza de rompecabezas)
2. Activar **Modo desarrollador** (esquina superior derecha)
3. Click en **Cargar extensión sin empaquetar**
4. Seleccionar la carpeta raíz del proyecto (la que resultó del `git clone`)

La extensión aparece en la barra de herramientas. Las credenciales OAuth2 vienen incluidas (son las del SDK de Google Cloud, públicas).

## Uso

1. Hacer click en el icono de la extensión y pulsar **Conectar con Google** (o click en el chip flotante dentro de Colab)
2. Autorizar los permisos en la ventana de Google que se abre
3. El popup muestra el saldo de CU, tasa de consumo y tiempo estimado
4. En cualquier pestaña de `colab.research.google.com`, aparece un chip flotante con el saldo

### Estados del chip

| Color | Significado |
|-------|-------------|
| Verde | Saldo por encima del 60% |
| Ámbar | Saldo entre 30% y 60% |
| Rojo | Saldo por debajo del 30% |
| Rojo pulsante | Saldo agotado (muestra cuenta regresiva si hay refill pendiente) |
| Gris | Sin autenticar o cargando |

El tooltip (hover sobre el chip) muestra el desglose: consumo por hora, tiempo estimado, sesiones activas y errores recientes.

## Multi-cuenta

La extensión soporta múltiples cuentas de Google simultáneamente.

### Agregar cuentas

Click en el botón **+** junto al selector de cuentas en el popup. Se abre una ventana de autenticación de Google. La nueva cuenta se agrega y se establece como activa.

### Cambiar de cuenta

- **Desde el popup**: seleccionar otra cuenta en el dropdown. La extensión cambia inmediatamente y muestra los datos de la cuenta seleccionada.
- **Automáticamente**: al cambiar de cuenta de Google en una página de Colab, la extensión detecta el cambio y actualiza el chip flotante y la cuenta activa automáticamente. La detección se basa en un `MutationObserver` que lee el botón de perfil de Google en el DOM — no hace llamadas de red.

### Eliminar cuenta

Click en **Eliminar cuenta** en el popup. Se revoca el token y se eliminan los datos de esa cuenta. Si hay otras cuentas almacenadas, la extensión cambia a la siguiente automáticamente.

### Migración

Si la extensión se actualiza desde una versión anterior (single-account), los datos existentes se migran automáticamente al formato multi-cuenta en el primer inicio.

## Arquitectura

```
┌──────────────────────────────────────┐
│          Google OAuth2 / API         │
└──────────────┬───────────────────────┘
               │
       ┌───────▼───────┐
       │ Service Worker │  background/service-worker.js
       │  (stateless)   │  OAuth2 PKCE, polling, token refresh
       └───────┬───────┘
               │
        chrome.storage.local
        {accounts: {email: {...}}, activeAccount}
               │
       ┌───────┴────────┐
       │                │
  ┌────▼────┐     ┌─────▼──────┐
  │  Popup  │     │  Content   │
  │         │     │  Script    │
  └─────────┘     └────────────┘
  popup/*          content/overlay.js
  selector +      chip + auto-detección
  métricas        de cuenta en página
```

- **Service Worker** (`background/service-worker.js`): gestiona autenticación OAuth2 con PKCE, refresca tokens, consulta el endpoint de cuota cada minuto y persiste todo en `chrome.storage.local`. Almacena múltiples cuentas en `accounts[email]` con una clave `activeAccount` que indica cuál es la cuenta activa. No mantiene estado mutable en memoria (requisito de Manifest V3).
- **Popup** (`popup/*`): lee `chrome.storage.local` y renderiza tres estados posibles (sin autenticar, autenticado, error). Incluye un selector de cuenta (dropdown + botón "+") y envía mensajes al Service Worker para login, logout y refresh manual.
- **Content Script** (`content/overlay.js`): se inyecta en páginas de Colab. Crea un Shadow DOM para aislar estilos y renderiza un chip flotante que refleja el estado de la cuenta activa. Incluye auto-detección de la cuenta de Google activa en la página mediante `MutationObserver`.

Los tres componentes se sincronizan mediante `chrome.storage.onChanged`.

## Estructura del proyecto

```
colab-quota/
├── manifest.json              Manifiesto MV3
├── background/
│   └── service-worker.js      Lógica principal (OAuth, polling, API, multi-cuenta)
├── popup/
│   ├── popup.html             Estructura del popup (selector de cuenta, métricas)
│   ├── popup.js               Renderizado y event handlers
│   └── popup.css              Estilos dark/industrial
├── content/
│   ├── overlay.js             Chip, tooltip, Shadow DOM, auto-detección de cuenta
│   └── overlay.css            (vacío — estilos dentro del Shadow DOM)
└── icons/
    ├── icon.svg               Icono fuente (SVG)
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

## Permisos

| Permiso | Tipo | Justificación |
|---------|------|---------------|
| `storage` | API | Persistir tokens OAuth, información de usuario y datos de cuota (multi-cuenta) |
| `alarms` | API | Programar polling cada minuto (necesario porque el Service Worker se suspende entre eventos) |
| `tabs` | API | Detectar la redirección OAuth a `http://localhost` durante la autenticación |
| `https://colab.research.google.com/*` | Host | Inyectar el content script (chip flotante) en páginas de Colab |
| `https://colab.pa.googleapis.com/*` | Host | Consultar el endpoint de cuota de Compute Units |
| `https://oauth2.googleapis.com/*` | Host | Intercambiar y refrescar tokens OAuth2 |
| `http://localhost/*` | Host | Capturar el código de autorización OAuth (redirect URI) |

La extensión no ejecuta código remoto.

## Privacidad

- **Almacenamiento**: tokens y datos de cuota se guardan exclusivamente en `chrome.storage.local`, que reside en el perfil del navegador. No se envían a servidores de terceros.
- **Comunicación**: la extensión solo se comunica con dominios de Google (`accounts.google.com`, `oauth2.googleapis.com`, `googleapis.com`).
- **Revocación**: al eliminar una cuenta, se intenta revocar el token con Google y se eliminan los datos de esa cuenta del storage local.
- **Sin telemetría**: no hay analytics, tracking ni envío de datos a servicios externos.
- **Detección de cuenta**: el content script lee el `aria-label` del botón de perfil de Google en el DOM de Colab para detectar la cuenta activa. Es una lectura local del DOM, no implica llamadas de red.

## Notas técnicas

**OAuth2 PKCE**: la extensión usa Proof Key for Code Exchange (S256) para el flujo de autorización, con `crypto.subtle` para generar el challenge. El flujo abre una ventana popup de Chrome (`chrome.windows.create`) en lugar de `launchWebAuthFlow` porque el redirect URI es `http://localhost`, no `https://<id>.chromiumapp.org`.

**Multi-cuenta**: los datos se almacenan en `chrome.storage.local` como `{ accounts: { "email": { tokens, userInfo, ccuInfo, ... } }, activeAccount: "email" }`. Cada cuenta tiene sus propios tokens, información de usuario y datos de cuota. El polling solo consulta la cuenta activa.

**Auto-detección**: el content script observa el DOM de Colab con un `MutationObserver` que detecta cambios en el `aria-label` del botón de perfil de Google. El formato `"Google Account: Name (email@domain)"` es consistente en todos los idiomas. Cuando el email detectado coincide con una cuenta almacenada diferente a la activa, se cambia automáticamente.

**XSSI prefix**: el endpoint de Colab antepone `)]}'\n` a las respuestas JSON como protección contra Cross-Site Script Inclusion. La extensión lo descarta antes de parsear.

**Milli-CCU**: el campo `remainingTokens` de la API devuelve milésimas de CU. Se divide entre 1000 para obtener el valor en CU.

**Shadow DOM**: el overlay usa Shadow DOM (`mode: open`) para que los estilos de Colab no afecten al chip ni al tooltip. Un `MutationObserver` lo re-inyecta si Colab lo elimina del DOM.

**Token refresh**: se refresca de forma proactiva 5 minutos antes de expirar. Si el refresh devuelve `invalid_grant`, se elimina la cuenta afectada (sin tocar las demás) y se limpia el alarm si no quedan cuentas.

## Limitaciones

- La API de cuota de Colab (`colab.pa.googleapis.com`) no es pública ni está documentada oficialmente. Puede cambiar o dejar de funcionar sin aviso.
- Las credenciales OAuth incluidas son las del SDK de Google Cloud (públicas). Si Google las revoca, la extensión dejará de funcionar hasta reemplazarlas.
- La extensión no funciona en Firefox (depende de APIs específicas de Chromium: `chrome.alarms`, `chrome.windows.create`, Manifest V3).
- La auto-detección de cuenta depende del `aria-label` del botón de perfil de Google en el DOM. Si Google cambia esta estructura, la detección dejaría de funcionar (el selector manual del popup seguiría disponible como fallback).
- Los PNGs se generaron proceduralmente a partir de un SVG fuente (`icons/icon.svg`).

## Licencia

MIT
