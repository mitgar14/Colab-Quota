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

// React to storage changes while popup is open (debounced to avoid flicker)
let _storageDebounce = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    clearTimeout(_storageDebounce);
    _storageDebounce = setTimeout(initPopup, 80);
  }
});

initPopup();
