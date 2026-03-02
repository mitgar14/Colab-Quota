# Colab Quota

Extensión de Chromium que muestra el consumo de Compute Units de Google Colab directamente en el navegador.

<!-- TODO: Reemplazar con captura o GIF real -->
<!-- ![Colab Quota en acción](assets/demo.gif) -->

## Tabla de contenidos

- [Qué hace](#qué-hace)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Uso](#uso)
- [Arquitectura](#arquitectura)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Permisos](#permisos)
- [Privacidad](#privacidad)
- [Notas técnicas](#notas-técnicas)
- [Limitaciones](#limitaciones)
- [Licencia](#licencia)

## Qué hace

La extensión consulta periódicamente el endpoint de Google Colab para obtener información de consumo de Compute Units (CU) y la presenta en dos lugares:

- **Popup**: al hacer click en el icono de la extensión, muestra el saldo total, tasa de consumo, tiempo estimado restante, plan actual y GPUs disponibles.
- **Overlay en Colab**: un chip flotante en la esquina inferior izquierda de `colab.research.google.com` que indica el saldo y consumo en tiempo real. Cambia de color según el nivel de saldo (verde, ámbar, rojo) y muestra una cuenta regresiva cuando las unidades se agotan.

Los datos se actualizan cada 5 minutos mediante `chrome.alarms`. No hay servidor intermedio: la extensión habla directamente con las APIs de Google.

## Requisitos

- Google Chrome o Chromium >= 120
- Una cuenta de Google con acceso a Colab
- Credenciales OAuth2 con acceso al scope `colaboratory` (ver [Instalación](#instalación))

## Instalación

No hay build, bundler ni dependencias npm. La extensión se carga directamente.

### 1. Clonar el repositorio

```bash
git clone https://github.com/<tu-usuario>/colab-quota.git
cd colab-quota
```

### 2. Configurar credenciales OAuth2

Copiar la plantilla y llenar los valores:

```bash
cp background/config.example.js background/config.js
```

Editar `background/config.js` con un `CLIENT_ID` y `CLIENT_SECRET` que tengan acceso al scope `https://www.googleapis.com/auth/colaboratory`. El `REDIRECT_URI` debe ser `http://localhost`.

> **Sobre las credenciales**: el endpoint de cuota de Colab (`colab.pa.googleapis.com`) es una API privada de Google. No se puede habilitar en proyectos GCP propios. Las credenciales deben pertenecer a un proyecto que ya tenga acceso — por ejemplo, las del [SDK de Google Cloud](https://github.com/xeodou/colab-cli/blob/master/auth.go) o las de la [extensión oficial de VS Code](https://github.com/googlecolab/colab-vscode).

### 3. Cargar en Chrome

1. Abrir `chrome://extensions/`
2. Activar **Modo desarrollador** (esquina superior derecha)
3. Click en **Cargar extensión sin empaquetar**
4. Seleccionar la carpeta raíz del proyecto (la que contiene `manifest.json`)

La extensión aparece en la barra de herramientas.

## Uso

1. Hacer click en el icono de la extensión y pulsar **Conectar con Google**
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

El tooltip (hover sobre el chip) muestra el desglose completo: balance, consumo por hora, tiempo estimado, sesiones activas, GPUs elegibles y plan.

## Arquitectura

```
┌─────────────────────────────────────┐
│         Google OAuth2 / API         │
└──────────────┬──────────────────────┘
               │
       ┌───────▼───────┐
       │ Service Worker │  background/service-worker.js
       │  (stateless)   │  OAuth2 PKCE, polling, token refresh
       └───────┬───────┘
               │
        chrome.storage.local
        (tokens, ccuInfo, timestamps)
               │
       ┌───────┴────────┐
       │                │
  ┌────▼────┐     ┌─────▼──────┐
  │  Popup  │     │  Content   │
  │         │     │  Script    │
  └─────────┘     └────────────┘
  popup/*          content/overlay.js
  click en icono   chip en colab.research.google.com
```

- **Service Worker** (`background/service-worker.js`): gestiona autenticación OAuth2 con PKCE, refresca tokens, consulta el endpoint de cuota cada 5 minutos y persiste todo en `chrome.storage.local`. No mantiene estado mutable en memoria (requisito de Manifest V3).
- **Popup** (`popup/*`): lee `chrome.storage.local` y renderiza tres estados posibles (sin autenticar, autenticado, error). Envía mensajes al Service Worker para login, logout y refresh manual.
- **Content Script** (`content/overlay.js`): se inyecta en páginas de Colab. Crea un Shadow DOM para aislar estilos y renderiza un chip flotante que refleja el estado actual del storage.

Los tres componentes se sincronizan mediante `chrome.storage.onChanged`.

## Estructura del proyecto

```
colab-quota/
├── manifest.json              Manifiesto MV3
├── background/
│   ├── service-worker.js      Lógica principal (OAuth, polling, API)
│   ├── config.js              Credenciales OAuth2 (gitignored)
│   └── config.example.js      Plantilla para config.js
├── popup/
│   ├── popup.html             Estructura del popup
│   ├── popup.js               Renderizado y event handlers
│   └── popup.css              Estilos dark/industrial
├── content/
│   ├── overlay.js             Chip, tooltip, Shadow DOM
│   └── overlay.css            (vacío — estilos dentro del Shadow DOM)
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

## Permisos

| Permiso | Tipo | Justificación |
|---------|------|---------------|
| `storage` | API | Persistir tokens OAuth, información de usuario y datos de cuota |
| `alarms` | API | Programar polling cada 5 minutos (necesario porque el Service Worker se suspende entre eventos) |
| `tabs` | API | Detectar la redirección OAuth a `http://localhost` durante la autenticación |
| `https://colab.research.google.com/*` | Host | Inyectar el content script (chip flotante) en páginas de Colab |
| `https://colab.pa.googleapis.com/*` | Host | Consultar el endpoint de cuota de Compute Units |
| `https://oauth2.googleapis.com/*` | Host | Intercambiar y refrescar tokens OAuth2 |
| `http://localhost/*` | Host | Capturar el código de autorización OAuth (redirect URI) |

La extensión no ejecuta código remoto.

## Privacidad

- **Almacenamiento**: tokens y datos de cuota se guardan exclusivamente en `chrome.storage.local`, que reside en el perfil del navegador. No se envían a servidores de terceros.
- **Comunicación**: la extensión solo se comunica con dominios de Google (`accounts.google.com`, `oauth2.googleapis.com`, `googleapis.com`).
- **Revocación**: al cerrar sesión ("Salir"), se intenta revocar el token con Google y se eliminan todos los datos del storage local.
- **Sin telemetría**: no hay analytics, tracking ni envío de datos a servicios externos.

## Notas técnicas

**OAuth2 PKCE**: la extensión usa Proof Key for Code Exchange (S256) para el flujo de autorización, con `crypto.subtle` para generar el challenge. El flujo abre una ventana popup de Chrome (`chrome.windows.create`) en lugar de `launchWebAuthFlow` porque el redirect URI es `http://localhost`, no `https://<id>.chromiumapp.org`.

**XSSI prefix**: el endpoint de Colab antepone `)]}'\n` a las respuestas JSON como protección contra Cross-Site Script Inclusion. La extensión lo descarta antes de parsear.

**Milli-CCU**: el campo `remainingTokens` de la API devuelve milésimas de CU. Se divide entre 1000 para obtener el valor en CU.

**Shadow DOM**: el overlay usa Shadow DOM (`mode: open`) para que los estilos de Colab no afecten al chip ni al tooltip. Un `MutationObserver` lo re-inyecta si Colab lo elimina del DOM.

**Token refresh**: se refresca de forma proactiva 5 minutos antes de expirar. Si el refresh devuelve `invalid_grant`, se limpia la sesión y se pide al usuario reconectar.

## Limitaciones

- La API de cuota de Colab (`colab.pa.googleapis.com`) no es pública ni está documentada oficialmente. Puede cambiar o dejar de funcionar sin aviso.
- Las credenciales OAuth deben ser de un proyecto GCP que ya tenga el scope de Colaboratory habilitado. No es posible usar credenciales de un proyecto propio.
- La extensión no funciona en Firefox (depende de APIs específicas de Chromium: `chrome.alarms`, `chrome.windows.create`, Manifest V3).
- Los iconos se generaron proceduralmente y no tienen versión de alta fidelidad en formato vectorial exportado.

## Licencia

MIT
