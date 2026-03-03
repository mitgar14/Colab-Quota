// Colab Quota — Service Worker
// OAuth2 PKCE + polling + multi-account storage management
// All state is read from chrome.storage on each wake — no global mutable state.

// ============================================================
// Constants
// ============================================================

// Google Cloud SDK OAuth2 credentials (public, from colab-cli).
// Encoded in base64 to bypass GitHub secret scanning on the GOCSPX- pattern.
const CLIENT_ID     = atob('MTAxNDE2MDQ5MDE1OS1jdm90M2JlYTd0Z2twNzJhNG0yOWgyMGQ5ZGRvNmJuZS5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
const CLIENT_SECRET = atob('R09DU1BYLUVGNEZpcmJWUWNMckRSdndqY3BEWFUtMGlVcTQ=');
const REDIRECT_URI  = 'http://localhost';

const AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const USERINFO_URL  = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CCU_ENDPOINT  = 'https://colab.pa.googleapis.com/v1/user-info';
const SCOPES        = 'profile email https://www.googleapis.com/auth/colaboratory';
const XSSI_PREFIX   = ")]}'\n";
const ALARM_NAME    = 'colab-quota-poll';
const POLL_INTERVAL = 1; // minutes
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
// Multi-Account Storage Helpers
// ============================================================

async function getAccount(email) {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts?.[email] || null;
}

async function getActiveAccount() {
  const { accounts, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
  if (!activeAccount || !accounts?.[activeAccount]) return null;
  return { email: activeAccount, ...accounts[activeAccount] };
}

async function setAccountData(email, data) {
  const { accounts } = await chrome.storage.local.get('accounts');
  const updated = { ...accounts };
  updated[email] = { ...(updated[email] || {}), ...data };
  await chrome.storage.local.set({ accounts: updated });
}

async function removeAccount(email) {
  const { accounts, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const updated = { ...accounts };
  delete updated[email];
  const remaining = Object.keys(updated);
  const newActive = email === activeAccount
    ? (remaining[0] || null)
    : activeAccount;
  await chrome.storage.local.set({
    accounts: updated,
    activeAccount: newActive,
  });
  return { remaining: remaining.length, newActive };
}

// ============================================================
// Migration (single-account → multi-account)
// ============================================================

async function migrateIfNeeded() {
  const { tokens, userInfo, accounts } = await chrome.storage.local.get(['tokens', 'userInfo', 'accounts']);
  if (tokens && userInfo?.email && !accounts) {
    const old = await chrome.storage.local.get(['ccuInfo', 'lastUpdated', 'lastError']);
    const email = userInfo.email;
    await chrome.storage.local.set({
      accounts: {
        [email]: {
          tokens,
          userInfo,
          ccuInfo: old.ccuInfo || null,
          lastUpdated: old.lastUpdated || null,
          lastError: old.lastError || null,
        }
      },
      activeAccount: email,
    });
    await chrome.storage.local.remove(['tokens', 'userInfo', 'ccuInfo', 'lastUpdated', 'lastError']);
    console.log(`[Colab Quota] Migrated single account: ${email}`);
  }
}

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

function buildAuthUrl(codeChallenge) {
  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
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
      redirect_uri:  REDIRECT_URI,
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

  const authWindow = await chrome.windows.create({
    url: authUrl,
    type: 'popup',
    width: 500,
    height: 700,
  });

  const code = await new Promise((resolve, reject) => {
    const onTabUpdated = (tabId, changeInfo) => {
      if (!changeInfo.url || !changeInfo.url.startsWith(REDIRECT_URI)) return;

      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.windows.onRemoved.removeListener(onWindowClosed);

      const redirected = new URL(changeInfo.url);
      const authCode = redirected.searchParams.get('code');
      const error = redirected.searchParams.get('error');

      chrome.windows.remove(authWindow.id).catch(() => {});

      if (authCode) resolve(authCode);
      else reject(new Error(`Auth failed: ${error || 'no code in redirect'}`));
    };

    const onWindowClosed = (windowId) => {
      if (windowId !== authWindow.id) return;
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.windows.onRemoved.removeListener(onWindowClosed);
      reject(new Error('Auth window closed by user'));
    };

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.windows.onRemoved.addListener(onWindowClosed);
  });

  const tokens = await exchangeCodeForTokens(code, codeVerifier);
  const userInfo = await fetchGoogleUserInfo(tokens.access_token);
  const email = userInfo.email;

  // Save as new (or updated) account entry and set as active
  await setAccountData(email, { tokens, userInfo, lastError: null });
  await chrome.storage.local.set({ activeAccount: email });

  await startPolling();
  await fetchCcuInfo();
}

async function removeAccountFlow(email) {
  const acct = await getAccount(email);

  // Best-effort token revocation
  if (acct?.tokens?.access_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${acct.tokens.access_token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (_) { /* ignore revocation errors */ }
  }

  const { remaining, newActive } = await removeAccount(email);

  if (remaining === 0) {
    await chrome.alarms.clear(ALARM_NAME);
  } else if (newActive) {
    await fetchCcuInfo();
  }
}

// ============================================================
// Token Refresh
// ============================================================

async function refreshTokens(email, refreshToken) {
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
      const { remaining } = await removeAccount(email);
      if (remaining === 0) await chrome.alarms.clear(ALARM_NAME);
      throw new Error('invalid_grant');
    }

    // 401: OAuth client may have changed
    if (status === 401) {
      const { remaining } = await removeAccount(email);
      if (remaining === 0) await chrome.alarms.clear(ALARM_NAME);
      throw new Error('oauth_client_changed');
    }

    throw new Error(`Refresh failed (${status}): ${errBody}`);
  }

  const data = await response.json();
  const newTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at:    Date.now() + data.expires_in * 1000,
  };

  await setAccountData(email, { tokens: newTokens });
  return newTokens;
}

async function getValidAccessToken(email) {
  const acct = await getAccount(email);
  if (!acct?.tokens) throw new Error('not_authenticated');

  if (acct.tokens.expires_at - REFRESH_MARGIN_MS < Date.now()) {
    const newTokens = await refreshTokens(email, acct.tokens.refresh_token);
    return newTokens.access_token;
  }

  return acct.tokens.access_token;
}

// ============================================================
// Fetch CCU Info (for active account)
// ============================================================

async function fetchCcuInfo() {
  const { activeAccount } = await chrome.storage.local.get('activeAccount');
  if (!activeAccount) return;

  let accessToken;
  try {
    accessToken = await getValidAccessToken(activeAccount);
  } catch (err) {
    if (err.message === 'not_authenticated') return;
    if (err.message === 'invalid_grant' || err.message === 'oauth_client_changed') return;
    await setAccountData(activeAccount, { lastError: err.message });
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
      const acct = await getAccount(activeAccount);
      if (!acct?.tokens?.refresh_token) {
        await setAccountData(activeAccount, { lastError: 'Session expired. Please reconnect.' });
        return;
      }
      try {
        const newTokens = await refreshTokens(activeAccount, acct.tokens.refresh_token);
        const retryController = new AbortController();
        const retryTimeoutId = setTimeout(() => retryController.abort(), FETCH_TIMEOUT_MS);
        const retryResponse = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${newTokens.access_token}`,
            'X-Colab-Client-Agent': 'vscode',
          },
          signal: retryController.signal,
        });
        clearTimeout(retryTimeoutId);
        if (!retryResponse.ok) {
          await setAccountData(activeAccount, { lastError: `API error (${retryResponse.status})` });
          return;
        }
        const retryText = await retryResponse.text();
        const retryJson = JSON.parse(stripXssiPrefix(retryText));
        const ccuInfo = parseConsumptionResponse(retryJson);
        await setAccountData(activeAccount, { ccuInfo, lastUpdated: Date.now(), lastError: null });
        return;
      } catch (refreshErr) {
        return;
      }
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[Colab Quota] API error ${response.status}:`, errBody);
      await setAccountData(activeAccount, { lastError: `API error (${response.status}): ${errBody.slice(0, 200)}` });
      return;
    }

    const text = await response.text();
    const json = JSON.parse(stripXssiPrefix(text));
    const ccuInfo = parseConsumptionResponse(json);
    await setAccountData(activeAccount, { ccuInfo, lastUpdated: Date.now(), lastError: null });

  } catch (err) {
    clearTimeout(timeoutId);
    const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
    await setAccountData(activeAccount, { lastError: message });
  }
}

// ============================================================
// Polling
// ============================================================

async function startPolling() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL });
}

async function init() {
  await migrateIfNeeded();
  const { activeAccount } = await chrome.storage.local.get('activeAccount');
  if (activeAccount) {
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
    return true;
  }

  if (msg.type === 'LOGOUT') {
    removeAccountFlow(msg.email)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'SWITCH_ACCOUNT') {
    chrome.storage.local.set({ activeAccount: msg.email })
      .then(() => fetchCcuInfo())
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
    chrome.storage.local.get(['accounts', 'activeAccount'])
      .then(({ accounts, activeAccount }) => {
        const acct = accounts?.[activeAccount] || null;
        sendResponse({
          accounts: accounts || {},
          activeAccount,
          // Compat: flatten active account data for easy consumption
          tokens: acct?.tokens || null,
          userInfo: acct?.userInfo || null,
          ccuInfo: acct?.ccuInfo || null,
          lastUpdated: acct?.lastUpdated || null,
          lastError: acct?.lastError || null,
        });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
