// Colab Quota — Service Worker
// OAuth2 PKCE + polling + storage management
// All state is read from chrome.storage on each wake — no global mutable state.

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
