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

    // Styles live inside Shadow DOM for encapsulation
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
    return `
      /* ── Colab Quota Overlay — Industrial monitoring aesthetic ── */

      @keyframes cq-slide-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes cq-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }

      @keyframes cq-tooltip-in {
        from {
          opacity: 0;
          transform: translateY(4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* ── Chip ── */

      .cq-chip {
        position: fixed;
        bottom: 24px;
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

      .cq-chip[data-status="ok"] {
        border-left-color: #3fb950;
      }

      .cq-chip[data-status="warning"] {
        border-left-color: #f0a030;
      }

      .cq-chip[data-status="danger"] {
        border-left-color: #f85149;
      }

      .cq-chip[data-status="exhausted"] {
        border-left-color: #f85149;
        animation: cq-slide-in 0.3s ease-out, cq-pulse 2s ease-in-out 0.3s infinite;
      }

      .cq-chip[data-status="loading"] {
        border-left-color: #6e7681;
        color: #8b949e;
      }

      .cq-chip[data-status="error"] {
        border-left-color: #f0a030;
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
        bottom: 58px;
        left: 12px;
        z-index: 99999;
        background: rgba(14, 17, 23, 0.95);
        color: #c9d1d9;
        border-radius: 8px;
        padding: 11px 14px;
        font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
        font-size: 11.5px;
        font-weight: 400;
        line-height: 1.65;
        min-width: 210px;
        max-width: 290px;
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
        box-shadow:
          0 2px 6px rgba(0, 0, 0, 0.4),
          0 8px 24px rgba(0, 0, 0, 0.3),
          inset 0 0.5px 0 rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.06);
        pointer-events: none;
        white-space: pre-line;
        animation: cq-tooltip-in 0.15s ease-out;
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
    for (const g of (ccuInfo.eligible?.gpus || [])) gpuParts.push(`\u2713 ${g}`);
    for (const g of (ccuInfo.ineligible?.gpus || [])) gpuParts.push(`\u2717 ${g}`);
    if (gpuParts.length) lines.push(`GPU  ${gpuParts.join('  ')}`);

    lines.push(`Plan ${tierLabel(ccuInfo.tier)}`);
    lines.push('');
    lines.push(`Actualizado ${formatTimeSince(lastUpdated)}`);

    if (lastError) lines.push(`\u26A0 ${lastError}`);

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
