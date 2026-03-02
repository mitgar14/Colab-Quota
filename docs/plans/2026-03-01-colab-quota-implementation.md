# Colab Quota Extension — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Chromium browser extension that monitors Google Colab Compute Units in real-time via OAuth2 + GAPI endpoint, showing a floating chip on Colab pages and a popup with auth/balance info.

**Architecture:** MV3 extension with a service worker handling OAuth2 PKCE + polling every 5 min to `colab.pa.googleapis.com/v1/user-info`. Data flows through `chrome.storage.local` to a content script (chip/tooltip injected in Shadow DOM) and a popup (login/balance/error states). Vanilla JS, no bundler.

**Tech Stack:** Vanilla JS, Chrome Extensions Manifest V3, OAuth2 PKCE, `chrome.identity.launchWebAuthFlow`, `chrome.alarms`, `chrome.storage.local`

**Design doc:** `docs/plans/2026-03-01-colab-quota-design.md`

**Reference code:** `googlecolab/colab-vscode` (GitHub, Apache-2.0) — authoritative schemas and client implementation.

---

## Pre-requisites

Before starting implementation, the developer must:

1. Create OAuth2 credentials in [GCP Console](https://console.cloud.google.com/apis/credentials):
   - Type: **Desktop app**
   - Note the `client_id` and `client_secret`
   - The redirect URI will be configured after the extension ID is known

2. Configure OAuth Consent Screen:
   - User type: **External**
   - Add scopes: `profile`, `email`, `https://www.googleapis.com/auth/colaboratory`
   - Add test users (your Google accounts)

3. After Task 1, load the extension in `chrome://extensions` (dev mode) to get the `EXTENSION_ID`, then add `https://<EXTENSION_ID>.chromiumapp.org/` as authorized redirect URI in GCP Console.

---

## Task 1: Project scaffolding — manifest + directory structure

**Files:**
- Create: `manifest.json`
- Create: `background/service-worker.js` (minimal)
- Create: `content/overlay.js` (minimal)
- Create: `content/overlay.css` (empty)
- Create: `popup/popup.html` (minimal)
- Create: `popup/popup.js` (minimal)
- Create: `popup/popup.css` (empty)
- Create: `icons/` (placeholder PNGs)

**Step 1: Create manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Colab Quota",
  "version": "0.1.0",
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

**Step 2: Create minimal background/service-worker.js**

```javascript
// Colab Quota — Service Worker
// OAuth2 PKCE + polling + storage management

console.log('[Colab Quota] Service worker loaded');
```

**Step 3: Create minimal content/overlay.js and content/overlay.css**

`content/overlay.js`:
```javascript
// Colab Quota — Content Script
// Chip flotante + tooltip + countdown

console.log('[Colab Quota] Content script loaded');
```

`content/overlay.css`: empty file.

**Step 4: Create minimal popup files**

`popup/popup.html`:
```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="popup.css">
  <title>Colab Quota</title>
</head>
<body>
  <div id="app">Colab Quota — loading...</div>
  <script src="popup.js"></script>
</body>
</html>
```

`popup/popup.js`:
```javascript
// Colab Quota — Popup
console.log('[Colab Quota] Popup loaded');
```

`popup/popup.css`: empty file.

**Step 5: Generate placeholder icons**

Generate simple 16x16, 48x48, and 128x128 PNG icons. These can be solid-color squares as placeholders. Use a canvas-based generation script or download simple icons.

**Step 6: Load extension in browser and verify**

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the extension directory
4. Verify no errors in the extension card
5. Note the `EXTENSION_ID` for OAuth2 redirect URI setup
6. Open a Colab tab — check console for `[Colab Quota] Content script loaded`
7. Click extension icon — popup should show "Colab Quota — loading..."

**Step 7: Commit**

```bash
git add manifest.json background/ content/ popup/ icons/
git commit -m "feat: project scaffolding with manifest v3 and placeholders"
```

---

## Task 2: Service Worker — Constants, PKCE helpers, and response parser

**Files:**
- Modify: `background/service-worker.js`

This task creates the pure utility functions that don't depend on Chrome APIs — PKCE generation, XSSI stripping, response parsing, tier mapping, time formatting. These are the building blocks for Tasks 3-6.

**Step 1: Write constants and PKCE helpers**

Add to `background/service-worker.js`:

```javascript
// ============================================================
// Constants
// ============================================================

const CLIENT_ID     = '__REPLACE_WITH_YOUR_CLIENT_ID__';
const CLIENT_SECRET = '__REPLACE_WITH_YOUR_CLIENT_SECRET__';
const AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const USERINFO_URL  = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CCU_ENDPOINT  = 'https://colab.pa.googleapis.com/v1/user-info';
const SCOPES        = 'profile email https://www.googleapis.com/auth/colaboratory';
const XSSI_PREFIX   = ")]}'\n";
const ALARM_NAME    = 'colab-quota-poll';
const POLL_INTERVAL = 5; // minutes
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes before expiry
const FETCH_TIMEOUT_MS  = 10 * 1000;     // 10 seconds

// Tier enum mapping
const TIER_MAP = {
  'SUBSCRIPTION_TIER_UNSPECIFIED': 'free',
  'SUBSCRIPTION_TIER_NONE':       'free',
  'SUBSCRIPTION_TIER_PRO':        'pro',
  'SUBSCRIPTION_TIER_PRO_PLUS':   'pro_plus',
};

// ============================================================
// PKCE Helpers
// ============================================================

function generateRandomBytes(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function base64UrlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePKCE() {
  const verifierBytes = generateRandomBytes(32);
  const codeVerifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(digest);
  return { codeVerifier, codeChallenge };
}

// ============================================================
// Response Parsing
// ============================================================

function stripXssiPrefix(text) {
  return text.startsWith(XSSI_PREFIX) ? text.slice(XSSI_PREFIX.length) : text;
}

function flattenAccelerators(accelerators) {
  const result = { gpus: [], tpus: [] };
  if (!Array.isArray(accelerators)) return result;
  for (const acc of accelerators) {
    const models = (acc.models || []).map(m => m.toUpperCase());
    if (acc.variant === 'VARIANT_GPU') {
      result.gpus.push(...models);
    } else if (acc.variant === 'VARIANT_TPU') {
      result.tpus.push(...models);
    }
  }
  return result;
}

function parseConsumptionResponse(raw) {
  const tier = TIER_MAP[raw.subscriptionTier] || 'free';
  const paidBalance = typeof raw.paidComputeUnitsBalance === 'number'
    ? raw.paidComputeUnitsBalance : 0;
  const burnRate = raw.consumptionRateHourly || 0;
  const activeSessions = raw.assignmentsCount || 0;
  const eligible = flattenAccelerators(raw.eligibleAccelerators);
  const ineligible = flattenAccelerators(raw.ineligibleAccelerators);

  let freeBalance = 0;
  let refillAt = null;
  if (raw.freeCcuQuotaInfo) {
    const tokens = Number(raw.freeCcuQuotaInfo.remainingTokens);
    if (Number.isSafeInteger(tokens)) {
      freeBalance = tokens / 1000; // milli-CCU -> CCU
    }
    if (raw.freeCcuQuotaInfo.nextRefillTimestampSec) {
      refillAt = raw.freeCcuQuotaInfo.nextRefillTimestampSec * 1000; // sec -> ms
    }
  }

  return {
    tier, paidBalance, freeBalance, burnRate,
    activeSessions, eligible, ineligible, refillAt,
  };
}
```

**Step 2: Verify extension still loads**

1. Go to `chrome://extensions`
2. Click reload on Colab Quota
3. Check no errors — click "Inspect views: service worker" and verify console shows `[Colab Quota] Service worker loaded`

**Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "feat(sw): add constants, PKCE helpers, and response parser"
```

---

## Task 3: Service Worker — OAuth2 authentication flow

**Files:**
- Modify: `background/service-worker.js`

Implements `authenticate()`, `exchangeCodeForTokens()`, `fetchUserInfo()`, and `logout()`.

**Step 1: Write auth functions**

Append to `background/service-worker.js`:

```javascript
// ============================================================
// OAuth2 Authentication
// ============================================================

function getRedirectUri() {
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

function buildAuthUrl(codeChallenge) {
  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          getRedirectUri(),
    response_type:         'code',
    scope:                 SCOPES,
    access_type:           'offline',
    prompt:                'consent',
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type:    'authorization_code',
      redirect_uri:  getRedirectUri(),
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + data.expires_in * 1000,
  };
}

async function fetchGoogleUserInfo(accessToken) {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`UserInfo failed (${response.status})`);
  const data = await response.json();
  return { name: data.name || '', email: data.email || '' };
}

async function authenticate() {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const authUrl = buildAuthUrl(codeChallenge);

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');
  if (!code) {
    const error = url.searchParams.get('error') || 'no code in redirect';
    throw new Error(`Auth failed: ${error}`);
  }

  const tokens = await exchangeCodeForTokens(code, codeVerifier);
  const userInfo = await fetchGoogleUserInfo(tokens.access_token);

  await chrome.storage.local.set({
    tokens,
    userInfo,
    lastError: null,
  });

  await startPolling();
  await fetchCcuInfo(); // first fetch immediately
}

async function logout() {
  const { tokens } = await chrome.storage.local.get('tokens');

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.storage.local.remove(['tokens', 'userInfo', 'ccuInfo', 'lastUpdated', 'lastError']);

  // Best-effort token revocation
  if (tokens?.access_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${tokens.access_token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (_) { /* ignore revocation errors */ }
  }
}
```

**Step 2: Verify extension loads without errors**

Reload the extension in `chrome://extensions`. Open the SW inspector — no errors should appear (the functions exist but are not called yet).

**Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "feat(sw): add OAuth2 PKCE auth, token exchange, and logout"
```

---

## Task 4: Service Worker — Token refresh

**Files:**
- Modify: `background/service-worker.js`

Implements `refreshTokens()` and `getValidAccessToken()`.

**Step 1: Write token refresh functions**

Append to `background/service-worker.js`:

```javascript
// ============================================================
// Token Refresh
// ============================================================

async function refreshTokens(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const status = response.status;

    // invalid_grant: token revoked or client changed
    if (status === 400 && errBody.includes('invalid_grant')) {
      await chrome.storage.local.remove(['tokens', 'userInfo', 'ccuInfo', 'lastUpdated']);
      await chrome.storage.local.set({ lastError: 'Session expired. Please reconnect.' });
      await chrome.alarms.clear(ALARM_NAME);
      throw new Error('invalid_grant');
    }

    // 401: OAuth client may have changed
    if (status === 401) {
      await chrome.storage.local.remove(['tokens', 'userInfo', 'ccuInfo', 'lastUpdated']);
      await chrome.storage.local.set({ lastError: 'Auth error. Please reconnect.' });
      await chrome.alarms.clear(ALARM_NAME);
      throw new Error('oauth_client_changed');
    }

    throw new Error(`Refresh failed (${status}): ${errBody}`);
  }

  const data = await response.json();
  const newTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken, // preserve if not returned
    expires_at:    Date.now() + data.expires_in * 1000,
  };

  await chrome.storage.local.set({ tokens: newTokens });
  return newTokens;
}

async function getValidAccessToken() {
  const { tokens } = await chrome.storage.local.get('tokens');
  if (!tokens) throw new Error('not_authenticated');

  if (tokens.expires_at - REFRESH_MARGIN_MS < Date.now()) {
    const newTokens = await refreshTokens(tokens.refresh_token);
    return newTokens.access_token;
  }

  return tokens.access_token;
}
```

**Step 2: Verify no errors**

Reload extension, inspect SW — no errors.

**Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "feat(sw): add token refresh with invalid_grant handling"
```

---

## Task 5: Service Worker — Fetch CCU info

**Files:**
- Modify: `background/service-worker.js`

Implements `fetchCcuInfo()` — the core data-fetching function.

**Step 1: Write fetchCcuInfo**

Append to `background/service-worker.js`:

```javascript
// ============================================================
// Fetch CCU Info
// ============================================================

async function fetchCcuInfo() {
  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    if (err.message === 'not_authenticated') return;
    // invalid_grant or oauth_client_changed already handled in refreshTokens
    if (err.message === 'invalid_grant' || err.message === 'oauth_client_changed') return;
    await chrome.storage.local.set({ lastError: err.message });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = `${CCU_ENDPOINT}?get_ccu_consumption_info=true`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-Colab-Client-Agent': 'vscode',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // 401: try refresh once then retry
    if (response.status === 401) {
      const { tokens } = await chrome.storage.local.get('tokens');
      if (!tokens?.refresh_token) {
        await chrome.storage.local.set({ lastError: 'Session expired. Please reconnect.' });
        return;
      }
      try {
        const newTokens = await refreshTokens(tokens.refresh_token);
        // Retry with new token
        const retryResponse = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${newTokens.access_token}`,
            'X-Colab-Client-Agent': 'vscode',
          },
        });
        if (!retryResponse.ok) {
          await chrome.storage.local.set({ lastError: `API error (${retryResponse.status})` });
          return;
        }
        const retryText = await retryResponse.text();
        const retryJson = JSON.parse(stripXssiPrefix(retryText));
        const ccuInfo = parseConsumptionResponse(retryJson);
        await chrome.storage.local.set({ ccuInfo, lastUpdated: Date.now(), lastError: null });
        return;
      } catch (refreshErr) {
        // invalid_grant already handled inside refreshTokens
        return;
      }
    }

    if (!response.ok) {
      await chrome.storage.local.set({ lastError: `API error (${response.status})` });
      return;
    }

    const text = await response.text();
    const json = JSON.parse(stripXssiPrefix(text));
    const ccuInfo = parseConsumptionResponse(json);
    await chrome.storage.local.set({ ccuInfo, lastUpdated: Date.now(), lastError: null });

  } catch (err) {
    clearTimeout(timeoutId);
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    await chrome.storage.local.set({ lastError: message });
  }
}
```

**Step 2: Verify no errors**

Reload extension, inspect SW — no errors.

**Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "feat(sw): add fetchCcuInfo with retry on 401 and timeout"
```

---

## Task 6: Service Worker — Polling, event listeners, and message handler

**Files:**
- Modify: `background/service-worker.js`

Implements `startPolling()`, `init()`, and all event listeners. This completes the service worker.

**Step 1: Write polling and event handlers**

Append to `background/service-worker.js`:

```javascript
// ============================================================
// Polling
// ============================================================

async function startPolling() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL });
}

async function init() {
  const { tokens } = await chrome.storage.local.get('tokens');
  if (tokens) {
    await startPolling();
  }
}

// ============================================================
// Event Listeners (must be at top-level scope for MV3)
// ============================================================

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Colab Quota] Extension installed');
  init();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Colab Quota] Browser started');
  init();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    fetchCcuInfo();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'LOGIN') {
    authenticate()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }

  if (msg.type === 'LOGOUT') {
    logout()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'REFRESH_NOW') {
    fetchCcuInfo()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get(['tokens', 'userInfo', 'ccuInfo', 'lastUpdated', 'lastError'])
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
```

**Step 2: Replace the old console.log at the top**

Remove the initial `console.log('[Colab Quota] Service worker loaded');` line — the `onInstalled`/`onStartup` listeners now handle logging.

**Step 3: Verify the complete service worker**

1. Reload extension in `chrome://extensions`
2. Inspect the SW — should see `[Colab Quota] Extension installed`
3. No errors in console

**Step 4: Commit**

```bash
git add background/service-worker.js
git commit -m "feat(sw): add polling, init, and message handler — service worker complete"
```

---

## Task 7: Popup — HTML structure and JS logic

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`

Implements the three popup states (unauth, auth, error) with full logic.

**Step 1: Write popup HTML**

Replace `popup/popup.html`:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="popup.css">
  <title>Colab Quota</title>
</head>
<body>
  <!-- State: Not authenticated -->
  <div id="state-unauth" class="state" hidden>
    <div class="header">
      <h1>Colab Quota</h1>
    </div>
    <div class="body">
      <p>Conecta tu cuenta Google para monitorear tus Compute Units.</p>
      <button id="btn-login" class="btn btn-primary">Conectar con Google</button>
    </div>
  </div>

  <!-- State: Authenticated -->
  <div id="state-auth" class="state" hidden>
    <div class="header">
      <h1>Colab Quota</h1>
      <span id="tier-badge" class="badge"></span>
    </div>
    <div class="user-info">
      <span id="user-email"></span>
    </div>
    <div class="balance-display">
      <span id="balance-value" class="balance-number"></span>
      <span class="balance-unit">CU</span>
    </div>
    <div class="details">
      <span id="burn-rate"></span>
      <span id="time-remaining"></span>
    </div>
    <div class="meta">
      <span id="last-updated"></span>
    </div>
    <div class="actions">
      <button id="btn-refresh" class="btn btn-secondary">Actualizar</button>
      <button id="btn-logout" class="btn btn-ghost">Salir</button>
    </div>
  </div>

  <!-- State: Error -->
  <div id="state-error" class="state" hidden>
    <div class="header">
      <h1>Colab Quota</h1>
    </div>
    <div class="body">
      <p class="error-message" id="error-text"></p>
      <button id="btn-retry" class="btn btn-primary">Reintentar</button>
    </div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

**Step 2: Write popup JS**

Replace `popup/popup.js`:

```javascript
// Colab Quota — Popup

const $ = (sel) => document.querySelector(sel);

// ============================================================
// Helpers
// ============================================================

function formatTimeRemaining(hours) {
  if (!hours || hours <= 0) return null;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}

function formatTimeSince(timestampMs) {
  if (!timestampMs) return '';
  const diffSec = Math.floor((Date.now() - timestampMs) / 1000);
  if (diffSec < 60) return 'hace unos segundos';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  return `hace ${diffHr}h`;
}

function tierLabel(tier) {
  if (tier === 'pro') return 'Pro';
  if (tier === 'pro_plus') return 'Pro+';
  return 'Free';
}

// ============================================================
// State rendering
// ============================================================

function showState(stateId) {
  document.querySelectorAll('.state').forEach(el => el.hidden = true);
  $(stateId).hidden = false;
}

function renderAuth(data) {
  const { userInfo, ccuInfo, lastUpdated } = data;

  $('#user-email').textContent = userInfo?.email || '';
  $('#tier-badge').textContent = tierLabel(ccuInfo?.tier);

  const totalBalance = (ccuInfo?.paidBalance || 0) + (ccuInfo?.freeBalance || 0);
  $('#balance-value').textContent = totalBalance.toFixed(1);

  const burnRate = ccuInfo?.burnRate || 0;
  if (burnRate > 0) {
    $('#burn-rate').textContent = `${burnRate.toFixed(2)} CU/hr`;
    const hoursLeft = totalBalance / burnRate;
    const formatted = formatTimeRemaining(hoursLeft);
    $('#time-remaining').textContent = formatted ? `· ${formatted}` : '';
  } else {
    $('#burn-rate').textContent = 'Sin consumo activo';
    $('#time-remaining').textContent = '';
  }

  $('#last-updated').textContent = formatTimeSince(lastUpdated);

  showState('#state-auth');
}

function renderError(errorMsg) {
  $('#error-text').textContent = errorMsg || 'Error desconocido';
  showState('#state-error');
}

function renderUnauth() {
  showState('#state-unauth');
}

// ============================================================
// Init + Event listeners
// ============================================================

async function initPopup() {
  const data = await chrome.storage.local.get(
    ['tokens', 'userInfo', 'ccuInfo', 'lastUpdated', 'lastError']
  );

  if (!data.tokens) {
    renderUnauth();
  } else if (data.lastError && !data.ccuInfo) {
    renderError(data.lastError);
  } else if (data.ccuInfo) {
    renderAuth(data);
  } else {
    // Tokens exist but no data yet — show auth with empty state
    renderAuth(data);
  }
}

$('#btn-login').addEventListener('click', async () => {
  $('#btn-login').disabled = true;
  $('#btn-login').textContent = 'Conectando...';
  const response = await chrome.runtime.sendMessage({ type: 'LOGIN' });
  if (!response.ok) {
    $('#btn-login').disabled = false;
    $('#btn-login').textContent = 'Conectar con Google';
    renderError(response.error);
  }
  // On success, storage.onChanged will trigger re-render
});

$('#btn-refresh').addEventListener('click', async () => {
  $('#btn-refresh').disabled = true;
  $('#btn-refresh').textContent = 'Actualizando...';
  await chrome.runtime.sendMessage({ type: 'REFRESH_NOW' });
  $('#btn-refresh').disabled = false;
  $('#btn-refresh').textContent = 'Actualizar';
});

$('#btn-logout').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT' });
  renderUnauth();
});

$('#btn-retry').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'REFRESH_NOW' });
  initPopup();
});

// React to storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    initPopup();
  }
});

initPopup();
```

**Step 3: Verify popup works**

1. Reload extension
2. Click extension icon — should show "Conecta tu cuenta Google" (unauth state)
3. No console errors in the popup inspector

**Step 4: Commit**

```bash
git add popup/popup.html popup/popup.js
git commit -m "feat(popup): add three-state popup with auth, balance, and error views"
```

---

## Task 8: Popup — CSS styling

**Files:**
- Modify: `popup/popup.css`

**IMPORTANT: Use the `frontend-design` and `impeccable` skills for this task.** The popup needs to look distinctive and polished — not generic. Target: clean, compact, dark-friendly, with personality. ~320px wide.

**Step 1: Design and write popup CSS using frontend-design skill**

The CSS must cover:
- `.state` containers, `.header` with `h1` + `.badge`
- `.balance-display` — large, prominent number
- `.btn-primary`, `.btn-secondary`, `.btn-ghost` — distinct button styles
- `.details`, `.meta` — secondary info text
- `.error-message` — error state styling
- Dark-on-white or dark theme — whichever the skill produces
- Smooth transitions for state changes
- 320px width constraint on `body`

**Step 2: Verify visual quality**

1. Reload extension
2. Click icon — inspect the unauth state visually
3. It should look intentional, not like a default HTML page

**Step 3: Commit**

```bash
git add popup/popup.css
git commit -m "style(popup): add polished popup styling"
```

---

## Task 9: Content Script — Shadow DOM host, chip, and tooltip

**Files:**
- Modify: `content/overlay.js`

Implements the chip, tooltip, and countdown, all injected inside a Shadow DOM container.

**Step 1: Write complete content script**

Replace `content/overlay.js`:

```javascript
// Colab Quota — Content Script
// Chip flotante + tooltip + countdown, encapsulated in Shadow DOM

(function () {
  'use strict';

  const HOST_ID = 'colab-quota-host';
  let countdownInterval = null;

  // ============================================================
  // Helpers
  // ============================================================

  function formatTimeRemaining(hours) {
    if (!hours || hours <= 0) return null;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
  }

  function formatCountdown(refillAtMs) {
    const diff = Math.max(0, refillAtMs - Date.now());
    if (diff === 0) return null;
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const s = Math.floor((diff % 60_000) / 1_000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatTimeSince(timestampMs) {
    if (!timestampMs) return '';
    const diffSec = Math.floor((Date.now() - timestampMs) / 1000);
    if (diffSec < 60) return 'hace unos segundos';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `hace ${diffMin} min`;
    const diffHr = Math.floor(diffMin / 60);
    return `hace ${diffHr}h`;
  }

  function tierLabel(tier) {
    if (tier === 'pro') return 'Pro';
    if (tier === 'pro_plus') return 'Pro+';
    return 'Free';
  }

  function getMaxEstimate(tier, paidBalance) {
    const defaults = { free: 100, pro: 100, pro_plus: 500 };
    const base = defaults[tier] || 100;
    return Math.max(base, paidBalance || 0);
  }

  function getBalanceStatus(balance, maxEstimate) {
    const pct = (balance / maxEstimate) * 100;
    if (pct > 60) return 'ok';
    if (pct > 30) return 'warning';
    return 'danger';
  }

  // ============================================================
  // DOM creation
  // ============================================================

  function createHost() {
    // Remove existing if somehow duplicated
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    // Stylesheet will be injected separately via overlay.css reference
    // But since we're in Shadow DOM, we need inline styles or a <style> tag
    const style = document.createElement('style');
    style.textContent = getOverlayStyles();
    shadow.appendChild(style);

    const chip = document.createElement('div');
    chip.id = 'cq-chip';
    chip.className = 'cq-chip';
    shadow.appendChild(chip);

    const tooltip = document.createElement('div');
    tooltip.id = 'cq-tooltip';
    tooltip.className = 'cq-tooltip';
    tooltip.hidden = true;
    shadow.appendChild(tooltip);

    // Hover events
    chip.addEventListener('mouseenter', () => { tooltip.hidden = false; });
    chip.addEventListener('mouseleave', () => { tooltip.hidden = true; });

    document.body.appendChild(host);
    return shadow;
  }

  function getOverlayStyles() {
    // PLACEHOLDER: This will be replaced with polished styles in Task 10
    // using frontend-design + impeccable skills
    return `
      .cq-chip {
        position: fixed;
        bottom: 24px;
        left: 12px;
        z-index: 99999;
        background: rgba(0, 0, 0, 0.8);
        color: #fff;
        border-radius: 8px;
        padding: 6px 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        cursor: default;
        user-select: none;
        backdrop-filter: blur(8px);
        transition: background 0.3s ease;
        line-height: 1.4;
      }
      .cq-chip[data-status="ok"] { border-left: 3px solid #22c55e; }
      .cq-chip[data-status="warning"] { border-left: 3px solid #eab308; }
      .cq-chip[data-status="danger"] { border-left: 3px solid #ef4444; }
      .cq-chip[data-status="exhausted"] {
        border-left: 3px solid #ef4444;
        animation: cq-pulse 1.5s ease-in-out infinite;
      }
      .cq-chip[data-status="loading"] { border-left: 3px solid #6b7280; }
      .cq-chip[data-status="error"] { border-left: 3px solid #f97316; }
      .cq-chip[data-status="unauth"] { border-left: 3px solid #6b7280; cursor: pointer; }

      @keyframes cq-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .cq-tooltip {
        position: fixed;
        bottom: 62px;
        left: 12px;
        z-index: 99999;
        background: rgba(0, 0, 0, 0.9);
        color: #e5e7eb;
        border-radius: 8px;
        padding: 10px 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        line-height: 1.6;
        min-width: 200px;
        max-width: 280px;
        backdrop-filter: blur(8px);
        pointer-events: none;
        white-space: pre-line;
      }
    `;
  }

  // ============================================================
  // Rendering
  // ============================================================

  function renderChip(shadow, data) {
    const chip = shadow.getElementById('cq-chip');
    const tooltip = shadow.getElementById('cq-tooltip');
    if (!chip || !tooltip) return;

    const { tokens, ccuInfo, lastUpdated, lastError } = data;

    // Clear countdown if running
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // State: not authenticated
    if (!tokens) {
      chip.dataset.status = 'unauth';
      chip.textContent = 'Colab Quota';
      chip.onclick = () => chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
      tooltip.textContent = 'Click para conectar tu cuenta Google';
      return;
    }

    // State: error (no data at all)
    if (lastError && !ccuInfo) {
      chip.dataset.status = 'error';
      chip.textContent = 'CU — error';
      tooltip.textContent = `Error: ${lastError}`;
      return;
    }

    // State: loading (tokens but no data yet)
    if (!ccuInfo) {
      chip.dataset.status = 'loading';
      chip.textContent = '-- CU';
      tooltip.textContent = 'Cargando datos...';
      return;
    }

    // State: data available
    const totalBalance = (ccuInfo.paidBalance || 0) + (ccuInfo.freeBalance || 0);
    const burnRate = ccuInfo.burnRate || 0;
    const maxEst = getMaxEstimate(ccuInfo.tier, ccuInfo.paidBalance);

    // Exhausted state
    if (totalBalance <= 0) {
      chip.dataset.status = 'exhausted';

      if (ccuInfo.refillAt && ccuInfo.refillAt > Date.now()) {
        // Countdown mode
        const updateCountdown = () => {
          const cd = formatCountdown(ccuInfo.refillAt);
          chip.textContent = cd ? `0 CU — refill en ${cd}` : '0 CU — refill inminente...';
          if (!cd && countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        };
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
      } else {
        chip.textContent = '0 CU — sin unidades';
      }
    } else {
      // Normal state with balance
      const status = getBalanceStatus(totalBalance, maxEst);
      chip.dataset.status = status;
      chip.textContent = `${totalBalance.toFixed(1)} CU`;
      if (burnRate > 0) {
        chip.textContent += ` · ${burnRate.toFixed(1)} CU/hr`;
      }
    }

    // Build tooltip content
    const lines = [];
    lines.push(`Balance\t\t${totalBalance.toFixed(1)} CU`);
    if (burnRate > 0) {
      lines.push(`Consumo\t\t${burnRate.toFixed(2)} CU/hr`);
      const hoursLeft = totalBalance / burnRate;
      const timeStr = formatTimeRemaining(hoursLeft);
      if (timeStr) lines.push(`Tiempo est.\t${timeStr}`);
    }
    lines.push(`Sesiones\t${ccuInfo.activeSessions || 0}`);
    lines.push('');

    // GPUs
    const gpuParts = [];
    for (const g of (ccuInfo.eligible?.gpus || [])) gpuParts.push(`✓ ${g}`);
    for (const g of (ccuInfo.ineligible?.gpus || [])) gpuParts.push(`✗ ${g}`);
    if (gpuParts.length) lines.push(`GPU  ${gpuParts.join('  ')}`);

    lines.push(`Plan ${tierLabel(ccuInfo.tier)}`);
    lines.push('');
    lines.push(`Actualizado ${formatTimeSince(lastUpdated)}`);

    if (lastError) lines.push(`⚠ ${lastError}`);

    tooltip.textContent = lines.join('\n');
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  let shadow = null;

  function ensureOverlay() {
    if (!document.getElementById(HOST_ID)) {
      shadow = createHost();
    }
    return shadow;
  }

  async function updateFromStorage() {
    const s = ensureOverlay();
    const data = await chrome.storage.local.get(
      ['tokens', 'ccuInfo', 'lastUpdated', 'lastError']
    );
    renderChip(s, data);
  }

  // Initial render
  updateFromStorage();

  // React to storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      updateFromStorage();
    }
  });

  // MutationObserver: re-inject if Colab removes our host
  const observer = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) {
      shadow = createHost();
      updateFromStorage();
    }
  });
  observer.observe(document.body, { childList: true });

})();
```

**Step 2: Verify on Colab**

1. Reload extension
2. Open `https://colab.research.google.com/`
3. Should see a dark chip at bottom-left saying "Colab Quota" (unauth state)
4. Hover over it — tooltip should appear

**Step 3: Commit**

```bash
git add content/overlay.js
git commit -m "feat(content): add chip, tooltip, countdown in Shadow DOM"
```

---

## Task 10: Content Script — CSS styling

**Files:**
- Modify: `content/overlay.js` (the `getOverlayStyles()` function)
- `content/overlay.css` remains empty (styles live inside Shadow DOM)

**IMPORTANT: Use the `frontend-design` and `impeccable` skills for this task.** Replace the placeholder styles in `getOverlayStyles()` with polished, distinctive CSS. The chip and tooltip should feel like a natural part of a developer tool — not generic AI output. Consider:

- Subtle glassmorphism or frosted-glass effect
- Color-coded left border (green/amber/red) that feels intentional
- Typography that matches Colab's monospace/developer aesthetic
- Smooth hover transition for the tooltip
- The pulse animation for exhausted state should feel urgent but not annoying
- The chip should be compact but readable

**Step 1: Replace getOverlayStyles() with polished CSS using frontend-design skill**

**Step 2: Verify on Colab visually**

**Step 3: Commit**

```bash
git add content/overlay.js
git commit -m "style(content): polished chip and tooltip styling"
```

---

## Task 11: Manual end-to-end testing

**Pre-requisite:** OAuth2 credentials configured in GCP Console with the correct redirect URI.

**Step 1: Replace CLIENT_ID and CLIENT_SECRET**

Edit `background/service-worker.js` — replace the `__REPLACE_WITH_YOUR_*__` placeholders with real credentials.

**Step 2: Test authentication flow**

1. Click extension icon → "Conectar con Google"
2. Google consent screen should open
3. Accept (click Advanced → Continue if "unverified app")
4. Popup should switch to authenticated state with balance

**Step 3: Test polling**

1. Wait 5 minutes (or temporarily change `POLL_INTERVAL` to `1` for testing)
2. Open SW inspector → check for periodic fetch logs
3. Check `chrome.storage.local` via SW console: `chrome.storage.local.get(null, console.log)`

**Step 4: Test content script on Colab**

1. Open `https://colab.research.google.com/`
2. Chip should appear with real balance data
3. Hover → tooltip shows detailed info
4. If balance is 0 with refill: countdown should tick

**Step 5: Test error handling**

1. Disconnect from internet → wait for next poll → chip should show error state
2. Reconnect → next poll should recover

**Step 6: Test logout**

1. Click extension icon → "Salir"
2. Popup should show unauth state
3. Chip should show "Colab Quota" (unauth)
4. `chrome.storage.local` should be clean

**Step 7: Final commit with real credentials removed**

Put back the placeholder constants (never commit real credentials):
```bash
git add background/service-worker.js
git commit -m "test: verify end-to-end flow works — credentials removed"
```

---

## Task 12: Create .gitignore and finalize

**Files:**
- Create: `.gitignore`

**Step 1: Create .gitignore**

```
# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

# Chrome extension packaging
*.crx
*.pem
*.zip
```

**Step 2: Final commit**

```bash
git add .gitignore
git commit -m "chore: add .gitignore"
```

---

## Summary of tasks

| # | Task | Component |
|---|------|-----------|
| 1 | Project scaffolding | All |
| 2 | Constants, PKCE, response parser | Service Worker |
| 3 | OAuth2 authentication flow | Service Worker |
| 4 | Token refresh | Service Worker |
| 5 | Fetch CCU info | Service Worker |
| 6 | Polling + event listeners | Service Worker |
| 7 | Popup HTML + JS | Popup |
| 8 | Popup CSS (use frontend-design skill) | Popup |
| 9 | Content script: chip + tooltip + countdown | Content Script |
| 10 | Content script CSS (use frontend-design skill) | Content Script |
| 11 | Manual end-to-end testing | All |
| 12 | .gitignore and finalize | Project |

Tasks 8 and 10 explicitly require the **frontend-design** and **impeccable** skills for visual quality.
