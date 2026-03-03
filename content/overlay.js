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
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });

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

    chip.addEventListener('mouseenter', () => { tooltip.hidden = false; });
    chip.addEventListener('mouseleave', () => { tooltip.hidden = true; });

    document.body.appendChild(host);
    return shadow;
  }

  function getOverlayStyles() {
    return `
      @keyframes cq-slide-in {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      @keyframes cq-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }

      @keyframes cq-tooltip-in {
        from { opacity: 0; transform: translateY(4px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* ── Chip ── */

      .cq-chip {
        position: fixed;
        bottom: 56px;
        left: 12px;
        z-index: 99999;
        background: rgba(14, 17, 23, 0.88);
        color: #e6edf3;
        border-radius: 6px;
        padding: 5px 11px 5px 13px;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
        font-size: 12.5px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.01em;
        cursor: default;
        user-select: none;
        line-height: 1.5;
        border-left: 3px solid transparent;
        backdrop-filter: blur(12px) saturate(1.4);
        -webkit-backdrop-filter: blur(12px) saturate(1.4);
        box-shadow:
          0 1px 3px rgba(0, 0, 0, 0.4),
          0 4px 12px rgba(0, 0, 0, 0.25),
          inset 0 0.5px 0 rgba(255, 255, 255, 0.06);
        transition:
          border-color 0.25s ease,
          background 0.25s ease,
          box-shadow 0.25s ease;
        animation: cq-slide-in 0.3s ease-out;
      }

      .cq-chip:hover {
        background: rgba(14, 17, 23, 0.94);
        box-shadow:
          0 1px 3px rgba(0, 0, 0, 0.4),
          0 6px 16px rgba(0, 0, 0, 0.35),
          inset 0 0.5px 0 rgba(255, 255, 255, 0.08);
      }

      /* ── Status colors ── */

      .cq-chip[data-status="ok"]        { border-left-color: #3fb950; }
      .cq-chip[data-status="warning"]   { border-left-color: #f0a030; }
      .cq-chip[data-status="danger"]    { border-left-color: #f85149; }
      .cq-chip[data-status="loading"]   { border-left-color: #6e7681; color: #8b949e; }
      .cq-chip[data-status="error"]     { border-left-color: #f0a030; }

      .cq-chip[data-status="exhausted"] {
        border-left-color: #f85149;
        animation: cq-slide-in 0.3s ease-out, cq-pulse 2s ease-in-out 0.3s infinite;
      }

      .cq-chip[data-status="unauth"] {
        border-left-color: #6e7681;
        cursor: pointer;
        color: #8b949e;
      }

      .cq-chip[data-status="unauth"]:hover {
        border-left-color: #f0a030;
        color: #e6edf3;
      }

      /* ── Tooltip ── */

      .cq-tooltip {
        position: fixed;
        bottom: 90px;
        left: 12px;
        z-index: 99999;
        background: rgba(14, 17, 23, 0.96);
        color: #c9d1d9;
        border-radius: 8px;
        padding: 0;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.5;
        min-width: 200px;
        max-width: 260px;
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        box-shadow:
          0 2px 6px rgba(0, 0, 0, 0.5),
          0 8px 24px rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.07);
        pointer-events: none;
        overflow: hidden;
        animation: cq-tooltip-in 0.15s ease-out;
      }

      /* ── Tooltip: simple text mode (unauth/error/loading) ── */

      .cq-tooltip-text {
        padding: 10px 12px;
        font-size: 11.5px;
        color: #8b949e;
      }

      /* ── Tooltip: structured metrics ── */

      .cq-tt-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }

      .cq-tt-row:last-child {
        border-bottom: none;
      }

      .cq-tt-label {
        color: #6e7681;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .cq-tt-value {
        color: #e6edf3;
        font-size: 11.5px;
        font-variant-numeric: tabular-nums;
      }

      .cq-tt-value.accent {
        color: #f0a030;
        font-weight: 600;
      }

      .cq-tt-value.dim {
        color: #6e7681;
      }

      .cq-tt-footer {
        padding: 5px 12px;
        font-size: 10px;
        color: #484f58;
        border-top: 1px solid rgba(255, 255, 255, 0.04);
        text-align: right;
      }

      .cq-tt-warn {
        padding: 5px 12px;
        font-size: 10px;
        color: #f0a030;
        border-top: 1px solid rgba(255, 255, 255, 0.04);
      }
    `;
  }

  // ============================================================
  // Tooltip builders
  // ============================================================

  function tooltipSimple(tooltip, text) {
    tooltip.innerHTML = `<div class="cq-tooltip-text">${text}</div>`;
  }

  function tooltipMetrics(tooltip, ccuInfo, lastUpdated, lastError) {
    const totalBalance = (ccuInfo.paidBalance || 0) + (ccuInfo.freeBalance || 0);
    const burnRate = ccuInfo.burnRate || 0;
    const sessions = ccuInfo.activeSessions || 0;
    const waitingRefill = totalBalance <= 0 && ccuInfo.refillAt && ccuInfo.refillAt > Date.now();

    let rows = '';

    if (waitingRefill) {
      const cd = formatCountdown(ccuInfo.refillAt);
      rows += row('Refill', cd || 'inminente...', 'accent');
      if (sessions > 0) {
        rows += row('Sesiones', `${sessions} (CPU)`);
      }
    } else {
      if (burnRate > 0) {
        const hoursLeft = totalBalance / burnRate;
        const timeStr = formatTimeRemaining(hoursLeft);
        if (timeStr) rows += row('Restante', timeStr);
      }

      if (sessions > 0) {
        const sessionLabel = burnRate > 0 ? `${sessions} (con GPU)` : `${sessions} (CPU)`;
        rows += row('Sesiones', sessionLabel);
      } else {
        rows += row('Sesiones', '0', 'dim');
      }
    }

    let footer = '';
    if (lastError) {
      footer += `<div class="cq-tt-warn">\u26A0 ${escapeHtml(lastError)}</div>`;
    }

    tooltip.innerHTML = rows + footer;
  }

  function row(label, value, cls) {
    const valClass = cls ? `cq-tt-value ${cls}` : 'cq-tt-value';
    return `<div class="cq-tt-row"><span class="cq-tt-label">${label}</span><span class="${valClass}">${escapeHtml(value)}</span></div>`;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // Rendering
  // ============================================================

  function renderChip(shadow, data) {
    const chip = shadow.getElementById('cq-chip');
    const tooltip = shadow.getElementById('cq-tooltip');
    if (!chip || !tooltip) return;

    const { tokens, ccuInfo, lastUpdated, lastError } = data;

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    // State: not authenticated
    if (!tokens) {
      chip.dataset.status = 'unauth';
      chip.textContent = 'Colab Quota';
      chip.onclick = async () => {
        chip.textContent = 'Conectando...';
        chip.onclick = null;
        const res = await chrome.runtime.sendMessage({ type: 'LOGIN' });
        if (!res.ok) updateFromStorage();
      };
      tooltipSimple(tooltip, 'Click para conectar tu cuenta Google');
      return;
    }

    // State: error (no data at all)
    if (lastError && !ccuInfo) {
      chip.dataset.status = 'error';
      chip.textContent = 'CU \u2014 error';
      tooltipSimple(tooltip, `Error: ${escapeHtml(lastError)}`);
      return;
    }

    // State: loading
    if (!ccuInfo) {
      chip.dataset.status = 'loading';
      chip.textContent = '\u2014\u2014 CU';
      tooltipSimple(tooltip, 'Cargando datos...');
      return;
    }

    // State: data available
    const totalBalance = (ccuInfo.paidBalance || 0) + (ccuInfo.freeBalance || 0);
    const burnRate = ccuInfo.burnRate || 0;
    const maxEst = getMaxEstimate(ccuInfo.tier, ccuInfo.paidBalance);

    chip.onclick = null;

    // Exhausted state
    if (totalBalance <= 0) {
      chip.dataset.status = 'exhausted';

      if (ccuInfo.refillAt && ccuInfo.refillAt > Date.now()) {
        const updateCountdown = () => {
          const cd = formatCountdown(ccuInfo.refillAt);
          chip.textContent = cd ? `0 CU \u00b7 ${cd}` : '0 CU \u00b7 refill...';
          if (!cd && countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        };
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
      } else {
        chip.textContent = '0 CU';
      }
      tooltipMetrics(tooltip, ccuInfo, lastUpdated, lastError);
    } else {
      const status = getBalanceStatus(totalBalance, maxEst);
      chip.dataset.status = status;
      chip.textContent = `${totalBalance.toFixed(1)} CU`;
      if (burnRate > 0) {
        chip.textContent += ` \u00b7 ${burnRate.toFixed(1)}/hr`;
      }
      tooltipMetrics(tooltip, ccuInfo, lastUpdated, lastError);
    }
  }

  // ============================================================
  // Page account auto-detection
  // ============================================================

  // Google's profile button always has aria-label with "(email@domain)" regardless of locale
  const EMAIL_RE = /\(([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\)/;

  function detectPageAccount() {
    for (const el of document.querySelectorAll('a[aria-label], button[aria-label]')) {
      const match = el.getAttribute('aria-label').match(EMAIL_RE);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  let _lastDetectedEmail = null;

  async function syncAccountWithPage(force) {
    const pageEmail = detectPageAccount();
    if (!pageEmail) return;
    if (!force && pageEmail === _lastDetectedEmail) return;
    _lastDetectedEmail = pageEmail;

    const { accounts, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
    if (!accounts) return;

    // Find stored account matching the page email (case-insensitive)
    const matchedEmail = Object.keys(accounts).find(e => e.toLowerCase() === pageEmail);
    if (matchedEmail && matchedEmail !== activeAccount) {
      await chrome.storage.local.set({ activeAccount: matchedEmail });
      updateFromStorage();
      chrome.runtime.sendMessage({ type: 'REFRESH_NOW' }).catch(() => {});
    }
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
    const { accounts, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
    const acct = accounts?.[activeAccount];
    const data = {
      tokens: acct?.tokens || null,
      ccuInfo: acct?.ccuInfo || null,
      lastUpdated: acct?.lastUpdated || null,
      lastError: acct?.lastError || null,
    };
    renderChip(s, data);
  }

  updateFromStorage();

  // ── Observers ──

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      updateFromStorage();
    }
  });

  // Re-inject chip if Colab removes it from the DOM
  const chipObserver = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) {
      shadow = createHost();
      updateFromStorage();
    }
  });
  chipObserver.observe(document.body, { childList: true });

  // ── Page account auto-detection ──
  // MutationObserver on <body> subtree detects when Google's profile button
  // changes (account switch, lazy load, SPA navigation). Pure DOM read — no
  // network calls, no rate-limiting risk.

  const accountObserver = new MutationObserver(() => syncAccountWithPage());
  accountObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });

  // Initial detection (Google bar may already be rendered)
  syncAccountWithPage();

  // Re-check on tab focus: another tab may have changed activeAccount
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncAccountWithPage(true);
    }
  });

})();
