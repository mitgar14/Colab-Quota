// Colab Quota — Service Worker
// OAuth2 PKCE + polling + storage management

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
