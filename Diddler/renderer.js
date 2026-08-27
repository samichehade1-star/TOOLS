// renderer.js — UI wiring for the titlebar, capture cards, log panel,
// accent color picker, and session auto-shutdown countdown. Talks to the
// engine only through window.api (preload.js).

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------
// color helpers — the picker only asks for one color; a second "partner"
// tone for gradients/glows is derived from it (hue-shifted + slightly
// desaturated) instead of asking the user to pick two.
// ---------------------------------------------------------------------
function hexToHsl(hex) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function deriveAccent2(accentHex) {
  const [h, s, l] = hexToHsl(accentHex);
  return hslToHex((h + 32) % 360, Math.max(35, s * 0.85), Math.min(62, l + 8));
}

function isValidHex(v) { return /^#[0-9a-fA-F]{6}$/.test(v); }

// ---------------------------------------------------------------------
// window chrome
// ---------------------------------------------------------------------
el('btnClose').addEventListener('click', () => window.api.close());
el('btnMin').addEventListener('click', () => window.api.minimize());
el('btnMax').addEventListener('click', () => window.api.maximize());

// ---------------------------------------------------------------------
// accent theme
// ---------------------------------------------------------------------
function applyTheme(accent) {
  const accent2 = deriveAccent2(accent);
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent2', accent2);
  el('customColor').value = accent;
  el('hexInput').value = accent.toUpperCase();
}

function setAccent(accent) {
  applyTheme(accent);
  window.api.saveTheme({ accent, accent2: deriveAccent2(accent) });
}

el('btnTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  el('themePopover').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!el('themePopover').contains(e.target) && e.target !== el('btnTheme')) {
    el('themePopover').classList.remove('open');
  }
});

el('customColor').addEventListener('input', (e) => setAccent(e.target.value));

el('hexInput').addEventListener('input', (e) => {
  let v = e.target.value.trim();
  if (v && !v.startsWith('#')) v = '#' + v;
  if (isValidHex(v)) setAccent(v);
});
el('hexInput').addEventListener('blur', () => {
  // snap back to the last valid color if the user left an incomplete hex behind
  el('hexInput').value = el('customColor').value.toUpperCase();
});

// ---------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------
function setStatus(text, colorVar) {
  el('statusText').textContent = text;
  el('statusDot').style.background = colorVar;
}

// ---------------------------------------------------------------------
// log panel
// ---------------------------------------------------------------------
function writeLog(message, level) {
  const body = el('logBody');
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const cls = { ok: 'log-ok', err: 'log-err', discovery: 'log-discovery' }[level] || 'log-info';
  line.innerHTML = `<span class="log-ts">[${ts}]  </span><span class="${cls}"></span>`;
  line.querySelector(`.${cls}`).textContent = message;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------------
// capture cards
// ---------------------------------------------------------------------
const cards = {
  add:    { input: el('addInput'),    paste: el('addPaste'),    send: el('addSend'),    badge: el('addBadge') },
  remove: { input: el('removeInput'), paste: el('removePaste'), send: el('removeSend'), badge: el('removeBadge') },
};

Object.entries(cards).forEach(([kind, c]) => {
  c.paste.addEventListener('click', async () => {
    const text = await window.api.readClipboard();
    if (text) { c.input.value = text; c.input.focus(); }
  });

  const trigger = () => sendRequest(kind);
  c.send.addEventListener('click', trigger);
  c.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); trigger(); }
  });
});

function sendRequest(kind) {
  const c = cards[kind];
  const id = c.input.value.trim();
  const label = kind === 'add' ? 'ADD' : 'REMOVE';
  if (!id) { writeLog(`${label} — enter a player ID first`, 'err'); return; }

  c.send.classList.add('sending');
  c.send.disabled = true;
  setStatus(`Sending ${label}...`, 'var(--accent)');
  window.api.sendRequest(kind, id);
}

// ---------------------------------------------------------------------
// engine events
// ---------------------------------------------------------------------
window.api.onEngineStatus(({ state, message }) => {
  if (state === 'starting') setStatus('Starting...', 'var(--gold)');
  else if (state === 'ready') {
    setStatus('Ready — trigger a friend request in DBD once to capture tokens', 'var(--text-mut)');
    writeLog('Ready — trigger a friend-add and friend-remove in DBD to capture tokens', 'info');
  } else if (state === 'error') {
    setStatus(message || 'Engine error', 'var(--danger)');
    writeLog(message || 'Engine error', 'err');
  }
});

window.api.onEngineLog(({ message, level }) => writeLog(message, level));

window.api.onEngineCaptured(({ kind }) => {
  const c = cards[kind];
  const label = kind === 'add' ? 'ADD' : 'REMOVE';
  c.badge.textContent = `${label} token ready`;
  c.badge.classList.add('ready');
  setStatus(`${label} token captured`, kind === 'add' ? 'var(--success)' : 'var(--warning)');
});

window.api.onEngineResult(({ kind, ok, status }) => {
  const c = cards[kind];
  const label = kind === 'add' ? 'ADD' : 'REMOVE';
  c.send.classList.remove('sending');
  c.send.disabled = false;

  if (ok) {
    setStatus(`${label} sent`, kind === 'add' ? 'var(--success)' : 'var(--warning)');
    writeLog(`${label} sent successfully  ->  ${c.input.value.trim().slice(0, 24)}`, 'ok');
  } else {
    setStatus(`${label} failed`, 'var(--danger)');
    writeLog(`${label} failed  ->  ${(status || '').slice(0, 160)}`, 'err');
  }
});

// ---------------------------------------------------------------------
// session auto-shutdown countdown
// ---------------------------------------------------------------------
const WARNING_TOTAL_S = 30;
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;
const ringFg = el('countdownRingFg');
ringFg.style.strokeDasharray = RING_C;

function updateCountdownRing(remaining) {
  const frac = Math.max(0, Math.min(1, remaining / WARNING_TOTAL_S));
  ringFg.style.strokeDashoffset = RING_C * (1 - frac);
  el('countdownNumber').textContent = Math.max(0, Math.ceil(remaining));
}

window.api.onSessionWarning(({ remaining }) => {
  el('sessionModal').classList.add('open');
  updateCountdownRing(remaining);
});
window.api.onSessionWarningHide(() => {
  el('sessionModal').classList.remove('open');
});
el('btnStillHere').addEventListener('click', () => {
  window.api.sessionStillHere();
  el('sessionModal').classList.remove('open');
});

// ---------------------------------------------------------------------
// auto-update
// ---------------------------------------------------------------------
let awaitingRestart = false;
el('btnUpdate').addEventListener('click', async () => {
  if (awaitingRestart) { window.api.installUpdate(); return; }
  el('btnUpdate').title = 'Checking for updates...';
  await window.api.checkForUpdates();
});

window.api.onUpdateStatus(({ status, version, percent, message }) => {
  switch (status) {
    case 'checking':
      el('btnUpdate').title = 'Checking for updates...';
      break;
    case 'available':
      el('btnUpdate').title = `Update ${version} available, downloading...`;
      window.api.downloadUpdate();
      break;
    case 'not-available':
      el('btnUpdate').title = 'You are on the latest version';
      break;
    case 'downloading':
      el('btnUpdate').title = `Downloading update... ${percent}%`;
      break;
    case 'downloaded':
      el('btnUpdate').title = 'Update downloaded — click to restart and install';
      awaitingRestart = true;
      break;
    case 'error':
      el('btnUpdate').title = `Update check failed: ${message}`;
      break;
  }
});

// ---------------------------------------------------------------------
// init
// ---------------------------------------------------------------------
(async () => {
  const state = await window.api.getState();
  applyTheme(state.theme.accent);
  setStatus('starting...', 'var(--text-mut)');
})();
