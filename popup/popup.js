// Colab Quota — Popup

const $ = (sel) => document.querySelector(sel);
let _refillInterval = null;

// ============================================================
// Helpers
// ============================================================

function formatTimeRemaining(hours) {
  if (!hours || hours <= 0) return null;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}

function formatCountdown(targetMs) {
  const diff = Math.max(0, targetMs - Date.now());
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

// ============================================================
// State rendering
// ============================================================

function showState(stateId) {
  document.querySelectorAll('.state').forEach(el => el.hidden = true);
  $(stateId).hidden = false;
}

function renderAuth(data) {
  const { userInfo, ccuInfo, lastUpdated } = data;

  // Clear previous refill interval
  if (_refillInterval) { clearInterval(_refillInterval); _refillInterval = null; }

  $('#user-email').textContent = userInfo?.email || '';
  $('#tier-badge').textContent = tierLabel(ccuInfo?.tier);

  // GPU tooltip on tier badge
  const gpus = [];
  for (const g of (ccuInfo?.eligible?.gpus || [])) gpus.push(`\u2713 ${g}`);
  for (const g of (ccuInfo?.ineligible?.gpus || [])) gpus.push(`\u2717 ${g}`);
  const tierTooltip = $('#tier-tooltip');
  tierTooltip.textContent = gpus.length ? gpus.join('\n') : '';

  const totalBalance = (ccuInfo?.paidBalance || 0) + (ccuInfo?.freeBalance || 0);
  $('#balance-value').textContent = totalBalance.toFixed(1);

  const burnRate = ccuInfo?.burnRate || 0;
  const waitingRefill = totalBalance <= 0 && ccuInfo?.refillAt && ccuInfo.refillAt > Date.now();

  // Refill countdown
  const refillRow = $('#refill-row');
  const refillEl = $('#refill-countdown');
  if (waitingRefill) {
    // Waiting for refill: show countdown, hide burn/time, keep sessions if active (CPU)
    $('#burn-row').hidden = true;
    $('#time-row').hidden = true;
    const sessions = ccuInfo?.activeSessions || 0;
    $('#sessions').textContent = String(sessions);
    $('#sessions-row').hidden = sessions === 0;
    refillRow.hidden = false;
    const updateRefill = () => {
      const cd = formatCountdown(ccuInfo.refillAt);
      refillEl.textContent = cd || 'inminente...';
      if (!cd && _refillInterval) { clearInterval(_refillInterval); _refillInterval = null; }
    };
    updateRefill();
    _refillInterval = setInterval(updateRefill, 1000);
  } else {
    // Normal: show consumption metrics, hide refill
    $('#burn-row').hidden = false;
    refillRow.hidden = true;
    refillEl.textContent = '';

    if (burnRate > 0) {
      $('#burn-rate').textContent = `${burnRate.toFixed(2)} CU/hr`;
      const hoursLeft = totalBalance / burnRate;
      const formatted = formatTimeRemaining(hoursLeft);
      $('#time-remaining').textContent = formatted || '--';
      $('#time-row').hidden = false;
    } else {
      $('#burn-rate').textContent = '0 CU/hr';
      $('#time-row').hidden = true;
    }

    const sessions = ccuInfo?.activeSessions || 0;
    $('#sessions').textContent = String(sessions);
    $('#sessions-row').hidden = false;
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
    if (response.error && response.error.includes('closed by user')) {
      renderUnauth();
    } else {
      renderError(response.error);
    }
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
