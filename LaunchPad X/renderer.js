const THEME_PRESETS = [
  { id: 'nebula', name: 'Nebula', accent: '#8b5cf6', accent2: '#38bdf8', bgFrom: '#0b0e17', bgTo: '#161227' },
  { id: 'ember', name: 'Ember', accent: '#f97316', accent2: '#ef4444', bgFrom: '#1a0e0a', bgTo: '#2b120c' },
  { id: 'emerald', name: 'Emerald', accent: '#10b981', accent2: '#22d3ee', bgFrom: '#071410', bgTo: '#0c1f1a' },
  { id: 'crimson', name: 'Crimson', accent: '#f43f5e', accent2: '#fb7185', bgFrom: '#170610', bgTo: '#250a1a' },
  { id: 'gold', name: 'Gold', accent: '#f59e0b', accent2: '#fbbf24', bgFrom: '#140f04', bgTo: '#1f1706' },
  { id: 'arctic', name: 'Arctic', accent: '#38bdf8', accent2: '#818cf8', bgFrom: '#060b14', bgTo: '#0d1626' },
];

// Recognizable per-platform brand colors — used as the fallback badge (and
// hero gradient) for a game with no cover art, so e.g. Roblox (no free art
// CDN of its own) still reads as "Roblox" at a glance instead of a generic
// dim tile.
const PLATFORM_COLORS = {
  'Steam': '#66c0f4',
  'Epic Games': '#c2c2c2',
  'Ubisoft': '#0d78f2',
  'Roblox': '#e2231a',
  'Microsoft': '#00a4ef',
  'Other': '#8b5cf6',
};

// mirrors main.js's LAUNCHABLE_EXTENSIONS — anything you'd normally just
// double-click to run, not only .exe
const LAUNCHABLE_EXTENSIONS = ['exe', 'bat', 'cmd', 'ahk', 'vbs', 'vbe', 'ps1', 'com', 'scr', 'msi'];

let state = { profiles: [], games: [], theme: {} };
let currentGameId = null;
let librarySearchQuery = '';

// ---------------------------------------------------------------- window chrome
document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

document.querySelectorAll('.dock-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  const navForView = { library: 'library', 'game-detail': 'library' };
  document.querySelectorAll('.dock-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === navForView[view]));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
}

document.getElementById('btn-back-to-library').addEventListener('click', () => switchView('library'));

const consoleDrawer = document.getElementById('console-drawer');
document.getElementById('console-toggle').addEventListener('click', () => consoleDrawer.classList.toggle('open'));
document.getElementById('console-close').addEventListener('click', () => consoleDrawer.classList.remove('open'));

const themeModalOverlay = document.getElementById('theme-modal-overlay');
document.getElementById('btn-theme-fab').addEventListener('click', () => { themeModalOverlay.style.display = 'flex'; });

let awaitingUpdateRestart = false;
const btnCheckUpdates = document.getElementById('btn-check-updates');
btnCheckUpdates.addEventListener('click', async () => {
  if (awaitingUpdateRestart) { window.api.installUpdate(); return; }
  btnCheckUpdates.setAttribute('data-tip', 'Checking for updates...');
  await window.api.checkForUpdates();
});
window.api.onUpdateStatus(({ status, version, percent, message }) => {
  switch (status) {
    case 'checking': btnCheckUpdates.setAttribute('data-tip', 'Checking for updates...'); break;
    case 'available':
      btnCheckUpdates.setAttribute('data-tip', `Update ${version} available, downloading...`);
      window.api.downloadUpdate();
      break;
    case 'not-available': btnCheckUpdates.setAttribute('data-tip', 'You are on the latest version'); break;
    case 'downloading': btnCheckUpdates.setAttribute('data-tip', `Downloading update... ${percent}%`); break;
    case 'downloaded':
      btnCheckUpdates.setAttribute('data-tip', 'Update downloaded — click to restart and install');
      awaitingUpdateRestart = true;
      break;
    case 'error': btnCheckUpdates.setAttribute('data-tip', `Update check failed: ${message}`); break;
  }
});
document.getElementById('theme-modal-close').addEventListener('click', () => { themeModalOverlay.style.display = 'none'; });
themeModalOverlay.addEventListener('click', (e) => { if (e.target === themeModalOverlay) themeModalOverlay.style.display = 'none'; });

// Editing a game or a tool always happens in a popup right where you found
// it (a library card, a game's tool card) — never by navigating to a
// separate list-of-everything screen. buildGameRow/buildAppRow are the same
// self-contained field-wiring used for both; only where the returned node
// gets mounted differs.
const editGameModalOverlay = document.getElementById('edit-game-modal-overlay');
const editGameModalBody = document.getElementById('edit-game-modal-body');
function openEditGameModal(game) {
  editGameModalBody.innerHTML = '';
  const row = buildGameRow(game);
  editGameModalBody.appendChild(row);
  editGameModalOverlay.style.display = 'flex';
  const nameInput = row.querySelector('.app-row-name');
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}
function closeEditGameModal() {
  editGameModalOverlay.style.display = 'none';
  editGameModalBody.innerHTML = '';
}
document.getElementById('edit-game-modal-close').addEventListener('click', closeEditGameModal);
editGameModalOverlay.addEventListener('click', (e) => { if (e.target === editGameModalOverlay) closeEditGameModal(); });

const editToolModalOverlay = document.getElementById('edit-tool-modal-overlay');
const editToolModalBody = document.getElementById('edit-tool-modal-body');
function openEditToolModal(profile) {
  refreshCategoryDatalist();
  editToolModalBody.innerHTML = '';
  const row = buildAppRow(profile);
  editToolModalBody.appendChild(row);
  editToolModalOverlay.style.display = 'flex';
  const nameInput = row.querySelector('.app-row-name');
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}
function closeEditToolModal() {
  editToolModalOverlay.style.display = 'none';
  editToolModalBody.innerHTML = '';
}
document.getElementById('edit-tool-modal-close').addEventListener('click', closeEditToolModal);
editToolModalOverlay.addEventListener('click', (e) => { if (e.target === editToolModalOverlay) closeEditToolModal(); });

// ---------------------------------------------------------------- splash
// Plays assets/intro.mp4 if it loads; if that file is ever missing, falls
// back to the pure CSS/SVG "spark -> streak -> mark draws in -> glow ->
// wordmark" sequence declared in styles.css (which starts on its own the
// moment #splash-fallback becomes visible — display:none suspends its
// animations entirely until then, so no separate timer is needed for it).
(function initSplash() {
  const overlay = document.getElementById('splash-overlay');
  const video = document.getElementById('splash-video');
  const fallback = document.getElementById('splash-fallback');
  const skipBtn = document.getElementById('splash-skip');
  let dismissed = false;

  function dismissSplash() {
    if (dismissed) return;
    dismissed = true;
    overlay.classList.add('fading');
    window.api.splashFinished(); // grows the window from the splash's square size to the real app size
    setTimeout(() => overlay.classList.add('hidden'), 520);
  }

  function useFallback() {
    video.parentElement.style.display = 'none';
    fallback.style.display = 'flex';
    setTimeout(dismissSplash, 3900);
  }

  // Trims to the 1s-9s window (skips the slow zoom-in lead-in and the tail)
  // without touching the actual file. Two things had to be worked around to
  // get here:
  // 1) `autoplay` racing a `currentTime` seek on 'loadedmetadata' let
  //    Chromium decode/seek through the video unpaced to the display before
  //    the window had even appeared — so play() is only called manually,
  //    once the seek has actually settled ('seeked').
  // 2) On a cold process start (first-ever decode of this file — GPU/codec
  //    pipeline warming up), 'timeupdate' can stall then fire a burst of
  //    catch-up events with currentTime jumping in large steps rather than
  //    smoothly, which made a currentTime-based cutoff fire almost
  //    immediately. Gating dismissal on a plain wall-clock timer instead
  //    sidesteps that entirely — the splash's on-screen duration no longer
  //    depends on the video element's own (occasionally unreliable) clock.
  const TRIM_START = 1;
  const TRIM_DURATION_MS = 8000; // 1s -> 9s
  let started = false;
  video.addEventListener('loadedmetadata', () => { video.currentTime = TRIM_START; });
  video.addEventListener('seeked', () => {
    if (started) return;
    started = true;
    video.play()
      .then(() => setTimeout(dismissSplash, TRIM_DURATION_MS))
      .catch(useFallback);
  });

  video.addEventListener('error', useFallback);
  video.addEventListener('ended', dismissSplash);
  skipBtn.addEventListener('click', dismissSplash);
  // safety net in case the video stalls without ever reaching the trim point
  setTimeout(dismissSplash, 12000);

  video.src = 'assets/intro.mp4';
  video.load();
})();

// ---------------------------------------------------------------- theming
function applyTheme(theme) {
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent2', theme.accent2);
  root.setProperty('--bg-from', theme.bgFrom);
  root.setProperty('--bg-to', theme.bgTo);
  root.setProperty('--card-opacity', theme.cardOpacity);

  document.getElementById('c-accent').value = theme.accent;
  document.getElementById('c-accent2').value = theme.accent2;
  document.getElementById('c-bgfrom').value = theme.bgFrom;
  document.getElementById('c-bgto').value = theme.bgTo;
  document.getElementById('c-opacity').value = theme.cardOpacity;

  document.querySelectorAll('.preset-swatch').forEach(s => s.classList.toggle('selected', s.dataset.id === theme.preset));
}

function renderThemePresets() {
  const wrap = document.getElementById('theme-presets');
  wrap.innerHTML = '';
  for (const p of THEME_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset-swatch';
    btn.dataset.id = p.id;
    btn.title = p.name;
    btn.style.background = `linear-gradient(135deg, ${p.accent}, ${p.accent2})`;
    btn.addEventListener('click', async () => {
      state.theme = { ...state.theme, ...p };
      applyTheme(state.theme);
      await window.api.saveTheme(state.theme);
    });
    wrap.appendChild(btn);
  }
}

let themeSaveTimer = null;
function wireThemeInputs() {
  const debounceSave = () => {
    clearTimeout(themeSaveTimer);
    themeSaveTimer = setTimeout(() => window.api.saveTheme(state.theme), 250);
  };
  const bind = (id, key) => {
    document.getElementById(id).addEventListener('input', (e) => {
      state.theme[key] = e.target.value;
      state.theme.preset = 'custom';
      applyTheme(state.theme);
      debounceSave();
    });
  };
  bind('c-accent', 'accent');
  bind('c-accent2', 'accent2');
  bind('c-bgfrom', 'bgFrom');
  bind('c-bgto', 'bgTo');
  document.getElementById('c-opacity').addEventListener('input', (e) => {
    state.theme.cardOpacity = parseFloat(e.target.value);
    applyTheme(state.theme);
    debounceSave();
  });
}

// ---------------------------------------------------------------- shared helpers
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// two-click delete confirmation, no native dialogs: first click arms the
// button (turns red, "Confirm?"), second click within 2.5s actually deletes
function bindDeleteConfirm(btn, onConfirm) {
  let armed = false;
  let timer = null;
  const original = btn.innerHTML;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      btn.classList.add('confirm-armed');
      btn.innerHTML = 'Confirm?';
      timer = setTimeout(() => { armed = false; btn.classList.remove('confirm-armed'); btn.innerHTML = original; }, 2500);
    } else {
      clearTimeout(timer);
      armed = false;
      btn.classList.remove('confirm-armed');
      btn.innerHTML = original;
      onConfirm();
    }
  });
}

// Shows a game's cover — `game.cover` is always the single source of truth,
// a concrete URL/data-URL resolved once (via the real Steam appdetails API,
// not guessed CDN paths that 404 for smaller/newer titles) and persisted, so
// rendering never has to guess or retry. Leaves the template's static
// fallback icon showing when there's nothing to display.
function resolveCoverImage(imgEl, game, onLoaded) {
  imgEl.classList.remove('loaded');
  if (!game.cover) return;
  imgEl.onerror = () => imgEl.classList.remove('loaded');
  imgEl.onload = () => {
    imgEl.classList.add('loaded');
    if (onLoaded) onLoaded(imgEl.src);
  };
  imgEl.src = game.cover;
}

// Self-heals games saved before the appdetails-based resolver existed (or
// added via scan-import) that have a steamAppId but no resolved cover yet —
// resolves it once in the background and persists the result so every
// future render just uses game.cover directly, no repeat lookups.
const artResolveInFlight = new Set();
async function ensureSteamArtResolved(game) {
  if (game.cover || game.coverSource !== 'steam' || !game.steamAppId) return;
  if (artResolveInFlight.has(game.id)) return;
  artResolveInFlight.add(game.id);
  try {
    const res = await window.api.resolveSteamArt(game.steamAppId);
    if (res.success) {
      const games = await window.api.saveGame({ id: game.id, cover: res.url });
      state.games = games;
      const updated = games.find(g => g.id === game.id);
      if (updated) Object.assign(game, updated);
      renderLibrary();
      if (currentGameId === game.id) renderGameHero(game);
    }
  } catch { /* best effort — leaves the fallback icon showing */ }
  finally {
    artResolveInFlight.delete(game.id);
  }
}

// ---------------------------------------------------------------- game library (Library view)
function renderLibrary() {
  const q = librarySearchQuery.trim().toLowerCase();
  const matchesQuery = (g) => !q || g.name.toLowerCase().includes(q) || g.platform.toLowerCase().includes(q);

  const visibleGames = state.games.filter(g => !g.hidden && matchesQuery(g));
  const hiddenGames = state.games.filter(g => g.hidden && matchesQuery(g));

  const grid = document.getElementById('game-grid');
  grid.innerHTML = '';
  for (const game of visibleGames) grid.appendChild(buildGameCard(game));
  document.getElementById('library-empty-hint').style.display = (visibleGames.length === 0 && state.games.length > 0) ? 'block' : 'none';

  const hiddenGamesBlock = document.getElementById('hidden-games-block');
  const hiddenGamesGrid = document.getElementById('hidden-games-grid');
  hiddenGamesGrid.innerHTML = '';
  document.getElementById('hidden-games-count').textContent = hiddenGames.length;
  if (hiddenGames.length) {
    hiddenGamesBlock.style.display = 'block';
    for (const game of hiddenGames) hiddenGamesGrid.appendChild(buildGameCard(game));
  } else {
    hiddenGamesBlock.style.display = 'none';
  }

  const unassignedAll = state.profiles.filter(p => !p.gameId || !state.games.some(g => g.id === p.gameId));
  const unassigned = unassignedAll.filter(p => !p.hidden);
  const unassignedHidden = unassignedAll.filter(p => p.hidden);

  const block = document.getElementById('unassigned-block');
  const cardsWrap = document.getElementById('unassigned-cards');
  cardsWrap.innerHTML = '';
  if (unassigned.length) {
    block.style.display = 'block';
    for (const p of unassigned) cardsWrap.appendChild(buildCard(p));
  } else {
    block.style.display = 'none';
  }

  const unassignedHiddenBlock = document.getElementById('unassigned-hidden-block');
  const unassignedHiddenCards = document.getElementById('unassigned-hidden-cards');
  unassignedHiddenCards.innerHTML = '';
  document.getElementById('unassigned-hidden-count').textContent = unassignedHidden.length;
  if (unassignedHidden.length) {
    unassignedHiddenBlock.style.display = 'block';
    for (const p of unassignedHidden) unassignedHiddenCards.appendChild(buildCard(p));
  } else {
    unassignedHiddenBlock.style.display = 'none';
  }
}

document.getElementById('library-search').addEventListener('input', (e) => {
  librarySearchQuery = e.target.value;
  renderLibrary();
});

function buildGameCard(game) {
  const tpl = document.getElementById('tpl-game-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = game.id;
  node.style.setProperty('--card-accent', PLATFORM_COLORS[game.platform] || PLATFORM_COLORS.Other);
  node.querySelector('.game-card-fallback-icon').textContent = (game.name.trim()[0] || '?').toUpperCase();
  const img = node.querySelector('.game-card-img');
  resolveCoverImage(img, game);
  ensureSteamArtResolved(game);

  node.querySelector('.game-card-platform').textContent = game.platform;
  const titleEl = node.querySelector('.game-card-title');
  titleEl.textContent = game.name;
  titleEl.style.setProperty('--title-chars', game.name.length);

  const toolCount = state.profiles.filter(p => p.gameId === game.id).length;
  node.querySelector('.game-card-toolcount').textContent = toolCount === 1 ? '1 tool' : `${toolCount} tools`;

  if (game.hidden) node.classList.add('game-card-hidden');
  const hideBtn = node.querySelector('.game-card-hide');
  hideBtn.title = game.hidden ? 'Unhide (show in Library)' : 'Hide from Library';
  hideBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    state.games = await window.api.saveGame({ id: game.id, hidden: !game.hidden });
    renderLibrary();
  });

  node.addEventListener('click', () => openGameDetail(game.id));
  bindDeleteConfirm(node.querySelector('.game-card-delete'), async () => {
    const res = await window.api.deleteGame(game.id);
    state.games = res.games;
    state.profiles = res.profiles;
    renderLibrary();
  });

  return node;
}

function openGameDetail(gameId) {
  const game = state.games.find(g => g.id === gameId);
  if (!game) return;
  currentGameId = gameId;
  renderGameHero(game);
  renderGameTools(game);
  switchView('game-detail');
}

function renderGameHero(game) {
  document.getElementById('game-hero').style.setProperty('--card-accent', PLATFORM_COLORS[game.platform] || PLATFORM_COLORS.Other);
  const bg = document.querySelector('.game-hero-bg');
  bg.style.backgroundImage = ''; // clear immediately so a previous game's art never lingers behind this one's title
  const bgImg = new Image();
  resolveCoverImage(bgImg, game, (src) => { bg.style.backgroundImage = `url("${src}")`; });
  ensureSteamArtResolved(game);

  document.querySelector('.game-hero-badge').textContent = game.platform;
  const titleEl = document.querySelector('.game-hero-title');
  titleEl.textContent = game.name;
  titleEl.style.setProperty('--title-chars', game.name.length);

  document.getElementById('game-hero-status').innerHTML = '';

  const launchBtn = document.getElementById('btn-launch-game');
  launchBtn.onclick = async () => {
    launchBtn.disabled = true;
    launchBtn.textContent = 'Launching…';
    const res = await window.api.launchGame(game.id);
    launchBtn.disabled = false;
    launchBtn.textContent = '▶ Launch Game';
    const statusEl = document.getElementById('game-hero-status');
    statusEl.className = `card-status ${res.success ? 'status-ok' : 'status-error'}`;
    statusEl.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(res.success ? 'Launched.' : res.error)}</span>`;
  };

  document.getElementById('btn-edit-game').onclick = () => openEditGameModal(game);

  const deleteBtn = document.getElementById('btn-delete-game');
  deleteBtn.replaceWith(deleteBtn.cloneNode(true)); // drop any previously-bound confirm handler
  bindDeleteConfirm(document.getElementById('btn-delete-game'), async () => {
    const res = await window.api.deleteGame(game.id);
    state.games = res.games;
    state.profiles = res.profiles;
    renderLibrary();
    switchView('library');
  });
}

function renderGameTools(game) {
  const wrap = document.getElementById('game-tools');
  wrap.innerHTML = '';
  const allForGame = state.profiles.filter(p => p.gameId === game.id);
  const tools = allForGame.filter(p => !p.hidden);
  const hiddenTools = allForGame.filter(p => p.hidden);

  if (tools.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-tools-hint';
    hint.textContent = `No tools linked to ${game.name} yet — add one with "+ Add Tool" above.`;
    wrap.appendChild(hint);
  } else {
    const groups = new Map();
    for (const p of tools) {
      const g = p.group || 'Custom';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    for (const [groupName, profiles] of groups) {
      const block = document.createElement('div');
      block.className = 'group-block';
      block.dataset.id = groupName;
      const h3 = document.createElement('h3');
      h3.textContent = groupName;
      h3.title = 'Drag to reorder this category';
      const cardsGrid = document.createElement('div');
      cardsGrid.className = 'group-cards';
      cardsGrid.dataset.group = groupName;
      for (const profile of profiles) cardsGrid.appendChild(buildCard(profile));
      block.appendChild(h3);
      block.appendChild(cardsGrid);
      wrap.appendChild(block);
    }
  }

  const hiddenBlock = document.getElementById('hidden-tools-block');
  const hiddenCards = document.getElementById('hidden-tools-cards');
  hiddenCards.innerHTML = '';
  document.getElementById('hidden-tools-count').textContent = hiddenTools.length;
  if (hiddenTools.length) {
    hiddenBlock.style.display = 'block';
    for (const p of hiddenTools) hiddenCards.appendChild(buildCard(p));
  } else {
    hiddenBlock.style.display = 'none';
  }

  attachToolCardSortables(handleToolCardReorder);
}

async function handleToolCardReorder({ movedId, newGroup }) {
  const ids = [...document.querySelectorAll('#game-tools .group-cards .card')].map(el => el.dataset.id);
  const movedProfile = state.profiles.find(p => p.id === movedId);
  const groupChanged = movedProfile && newGroup && movedProfile.group !== newGroup;
  if (groupChanged) {
    state.profiles = await window.api.saveProfile({ id: movedId, group: newGroup });
  }
  state.profiles = await window.api.reorderProfiles(ids);
  // a group emptied out by the move leaves a stale header behind until the
  // groups are rebuilt from scratch, so re-render rather than trust the
  // in-place DOM the drag already produced.
  if (groupChanged) {
    const game = state.games.find(g => g.id === currentGameId);
    if (game) renderGameTools(game);
  }
}

// "+ Add Tool" opens a modal rather than immediately creating a blank
// profile — reusing an existing tool (from any game) is at least as common
// as starting fresh, and neither path leaves this page.
const addToolModalOverlay = document.getElementById('add-tool-modal-overlay');

function closeAddToolModal() { addToolModalOverlay.style.display = 'none'; }
document.getElementById('add-tool-modal-close').addEventListener('click', closeAddToolModal);
addToolModalOverlay.addEventListener('click', (e) => { if (e.target === addToolModalOverlay) closeAddToolModal(); });

async function createNewToolForCurrentGame() {
  if (!currentGameId) return;
  const newProfile = await window.api.addProfile({ gameId: currentGameId, group: 'Custom' });
  state.profiles.push(newProfile);
  closeAddToolModal();
  renderLibrary();
  const game = state.games.find(g => g.id === currentGameId);
  if (game) renderGameTools(game);
  openEditToolModal(newProfile);
}
document.getElementById('btn-create-new-tool').addEventListener('click', createNewToolForCurrentGame);

document.getElementById('btn-add-tool').addEventListener('click', () => {
  if (!currentGameId) return;
  const game = state.games.find(g => g.id === currentGameId);
  document.getElementById('add-tool-game-name').textContent = game ? game.name : '';

  const list = document.getElementById('add-tool-existing-list');
  list.innerHTML = '';
  // only tools NOT already on this game are worth offering — the whole bank
  // is deliberately not shown on the game page itself, only here on-demand
  const candidates = state.profiles.filter(p => p.gameId !== currentGameId);
  if (candidates.length === 0) {
    list.innerHTML = '<div class="empty-tools-hint">No other tools to reuse yet — every tool you\'ve made already belongs to this game.</div>';
  } else {
    for (const p of candidates) list.appendChild(buildExistingToolRow(p));
  }
  addToolModalOverlay.style.display = 'flex';
});

function buildExistingToolRow(profile) {
  const tpl = document.getElementById('tpl-existing-tool-row');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.et-group').textContent = profile.group || 'Custom';
  node.querySelector('.et-name').textContent = profile.name;
  const sourceGame = state.games.find(g => g.id === profile.gameId);
  node.querySelector('.et-source').textContent = sourceGame ? `from ${sourceGame.name}` : 'unassigned';
  const addBtn = node.querySelector('.et-add');
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    const res = await window.api.duplicateProfile(profile.id, currentGameId);
    if (res.success) {
      state.profiles = res.profiles;
      renderLibrary();
      const game = state.games.find(g => g.id === currentGameId);
      if (game) renderGameTools(game);
      addBtn.textContent = '✓ Added';
    }
  });
  return node;
}

// ---------------------------------------------------------------- tool cards (shared: library unassigned + game detail)
const launchState = new Map(); // profileId -> { kind, message, attempt }

function buildCard(profile) {
  const tpl = document.getElementById('tpl-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = profile.id;
  node.style.setProperty('--card-accent', profile.color);
  node.querySelector('.card-name').textContent = profile.name;
  node.querySelector('.card-group').textContent = methodLabel(profile.method);
  if (!profile.targetPath) node.classList.add('no-path');

  node.querySelector('.card-edit').addEventListener('click', () => openEditToolModal(profile));

  node.querySelector('.btn-launch').addEventListener('click', () => runLaunch(profile.id));
  node.querySelector('.btn-cancel').addEventListener('click', () => window.api.cancelLaunch(profile.id));

  applyCardStatus(node, launchState.get(profile.id));
  return node;
}

function methodLabel(method) {
  if (method === 'direct') return 'Direct Path';
  if (method === 'folder') return 'Folder Scan';
  if (method === 'archive') return 'Extract + Retry';
  return method;
}

async function runLaunch(profileId) {
  const profile = state.profiles.find(p => p.id === profileId);
  if (!profile || !profile.targetPath) {
    setCardStatus(profileId, 'error', 'No path configured yet — click ✎ Edit to set one.');
    return;
  }
  setCardStatus(profileId, 'trying', 'Launching…', 1);
  const res = await window.api.launchProfile(profileId);
  if (res.success) {
    setCardStatus(profileId, 'ok', res.message);
  } else if (res.cancelled) {
    setCardStatus(profileId, 'idle', 'Cancelled.');
  } else {
    // The "already running" guard is a heuristic (matches processes by
    // folder/exe path, not an exact PID) — offer a way to skip it rather
    // than leaving someone stuck if it ever mismatches for a given tool.
    const isAlreadyRunning = /already running/i.test(res.error || '');
    setCardStatus(profileId, 'error', res.error, undefined, isAlreadyRunning);
  }
}

function setCardStatus(profileId, kind, message, attempt, forceOption) {
  launchState.set(profileId, { kind, message, attempt, forceOption });
  document.querySelectorAll(`.card[data-id="${profileId}"]`).forEach(card => applyCardStatus(card, launchState.get(profileId)));
}

function applyCardStatus(card, s) {
  const statusEl = card.querySelector('.card-status');
  const launchBtn = card.querySelector('.btn-launch');
  card.classList.remove('retrying');
  statusEl.className = 'card-status';
  if (!s) { statusEl.innerHTML = ''; launchBtn.disabled = false; launchBtn.textContent = 'Launch'; return; }

  const dotClass = (s.kind === 'trying' || s.kind === 'waiting') ? 'status-dot pulsing' : 'status-dot';
  if (s.kind === 'ok') statusEl.classList.add('status-ok');
  else if (s.kind === 'error') statusEl.classList.add('status-error');
  else if (s.kind === 'trying' || s.kind === 'waiting') statusEl.classList.add('status-warn');

  const forceBtn = s.forceOption
    ? ` <button class="link-btn force-relaunch-btn" data-id="${card.dataset.id}" title="Skip the already-running check and launch anyway">force relaunch</button>`
    : '';
  statusEl.innerHTML = `<span class="${dotClass}"></span><span>${escapeHtml(s.message || '')}</span>${forceBtn}`;
  launchBtn.disabled = (s.kind === 'trying' || s.kind === 'waiting');
  launchBtn.textContent = s.kind === 'trying' ? 'Launching…' : (s.kind === 'waiting' ? 'Retrying…' : 'Launch');
  if (s.kind === 'trying' || s.kind === 'waiting') card.classList.add('retrying');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.force-relaunch-btn');
  if (!btn) return;
  await window.api.forceClearActiveRun(btn.dataset.id);
  runLaunch(btn.dataset.id);
});

window.api.onLaunchProgress((payload) => {
  const { profileId, attempt, status, delayMs } = payload;
  if (status === 'trying') {
    setCardStatus(profileId, 'trying', attempt > 1 ? `Attempt ${attempt}…` : 'Launching…', attempt);
  } else if (status === 'waiting') {
    const secs = Math.round((delayMs || 0) / 1000);
    setCardStatus(profileId, 'waiting', `Attempt ${attempt} failed — retrying in ${secs}s…`, attempt);
  }
});

// ---------------------------------------------------------------- console
window.api.onLog(({ message, type, timestamp }) => {
  const log = document.getElementById('console-log');
  const line = document.createElement('div');
  line.className = `console-line type-${type}`;
  line.innerHTML = `<span class="ts">${timestamp}</span>${escapeHtml(message)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
});

// ---------------------------------------------------------------- settings: game library management
let scanningGames = false;

function isAlreadyInLibrary(detected) {
  return state.games.some(g => {
    if (detected.platform !== g.platform) return false;
    if (detected.launch.type === 'steam') return g.steamAppId === detected.launch.steamAppId;
    if (detected.launch.type === 'epic') return g.epicAppName === detected.launch.epicAppName;
    if (detected.launch.type === 'xbox') return g.xboxLaunchId === detected.launch.xboxLaunchId;
    if (detected.launch.type === 'ubisoft') return g.ubisoftId === detected.launch.ubisoftId;
    if (detected.launch.type === 'roblox') return true; // only one Roblox install ever makes sense
    return false;
  });
}

// Scan & Import lives in its own modal rather than inline in the Games
// panel — a real scan can turn up dozens of installed games, and dumping
// that list into the page pushed the Tool Profiles panel far down the page.
const scanModalOverlay = document.getElementById('scan-modal-overlay');
const scanModalBody = document.getElementById('scan-modal-body');

function openScanModal() {
  scanModalOverlay.style.display = 'flex';
  runGameScan();
}
function closeScanModal() {
  scanModalOverlay.style.display = 'none';
}
document.getElementById('btn-scan-games').addEventListener('click', openScanModal);
document.getElementById('scan-modal-close').addEventListener('click', closeScanModal);
scanModalOverlay.addEventListener('click', (e) => { if (e.target === scanModalOverlay) closeScanModal(); });

async function runGameScan() {
  if (scanningGames) return;
  scanningGames = true;
  scanModalBody.innerHTML = '<div class="empty-tools-hint">Scanning your Steam / Epic / Xbox libraries…</div>';
  const res = await window.api.scanGames();
  scanningGames = false;

  scanModalBody.innerHTML = '';
  if (!res.success) {
    scanModalBody.innerHTML = `<div class="empty-tools-hint">Scan failed: ${escapeHtml(res.error || 'unknown error')}</div>`;
    return;
  }
  const fresh = res.games.filter(g => !isAlreadyInLibrary(g));
  if (fresh.length === 0) {
    scanModalBody.innerHTML = '<div class="empty-tools-hint">No new games found (or everything detected is already in your library).</div>';
    return;
  }
  for (const detected of fresh) scanModalBody.appendChild(buildScanResultRow(detected));
}

function buildScanResultRow(detected) {
  const tpl = document.getElementById('tpl-scan-result-row');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.sr-platform').textContent = detected.platform;
  node.querySelector('.sr-name').textContent = detected.name;
  const addBtn = node.querySelector('.sr-add');
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    const newGame = await window.api.addGame({
      name: detected.name,
      platform: detected.platform,
      detectedName: detected.name,
      coverSource: detected.platform === 'Steam' ? 'steam' : '',
      steamAppId: detected.launch.steamAppId || '',
      epicAppName: detected.launch.epicAppName || '',
      xboxLaunchId: detected.launch.xboxLaunchId || '',
      ubisoftId: detected.launch.ubisoftId || '',
      exePath: detected.launch.exePath || '',
    });
    state.games.push(newGame);
    renderLibrary();
    ensureSteamArtResolved(newGame);
    addBtn.textContent = '✓ Added';
  });
  return node;
}

document.getElementById('btn-add-game').addEventListener('click', async () => {
  const newGame = await window.api.addGame({});
  state.games.push(newGame);
  renderLibrary();
  openEditGameModal(newGame);
});

function buildGameRow(game) {
  const tpl = document.getElementById('tpl-game-row');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = game.id;
  node.classList.add('expanded'); // always shown fully expanded — this row only ever lives inside its own edit modal now
  if (game.hidden) node.classList.add('item-hidden');

  const nameInput = node.querySelector('.app-row-name');
  nameInput.value = game.name;
  node.querySelector('.app-row-badge').textContent = game.platform;

  const thumbImg = node.querySelector('.g-thumb-img');
  resolveCoverImage(thumbImg, game);
  ensureSteamArtResolved(game);

  const hideBtn = node.querySelector('.app-row-hide');
  hideBtn.textContent = game.hidden ? 'unhide' : 'hide';
  hideBtn.addEventListener('click', async () => {
    const games = await window.api.saveGame({ id: game.id, hidden: !game.hidden });
    state.games = games;
    Object.assign(game, games.find(g => g.id === game.id));
    hideBtn.textContent = game.hidden ? 'unhide' : 'hide';
    node.classList.toggle('item-hidden', !!game.hidden);
    renderLibrary();
  });

  const platform = node.querySelector('.g-platform');
  const steamId = node.querySelector('.g-steamid');
  const epicName = node.querySelector('.g-epicname');
  const ubisoftId = node.querySelector('.g-ubisoftid');
  const exe = node.querySelector('.g-exe');
  const exeBrowse = node.querySelector('.g-exe-browse');
  const steamIdLabel = node.querySelector('.g-steamid-label');
  const epicNameLabel = node.querySelector('.g-epicname-label');
  const ubisoftIdLabel = node.querySelector('.g-ubisoftid-label');
  const exeLabel = node.querySelector('.g-exe-label');
  const coverPick = node.querySelector('.g-cover-pick');
  const coverSteam = node.querySelector('.g-cover-steam');
  const coverFindBtn = node.querySelector('.g-cover-find');
  const coverFindStatus = node.querySelector('.cover-find-status');
  const robloxNote = node.querySelector('.g-roblox-note');

  platform.value = game.platform;
  steamId.value = game.steamAppId || '';
  epicName.value = game.epicAppName || '';
  ubisoftId.value = game.ubisoftId || '';
  exe.value = game.exePath || '';
  updateFieldVisibility();

  function updateFieldVisibility() {
    const p = platform.value;
    steamIdLabel.style.display = p === 'Steam' ? 'flex' : 'none';
    epicNameLabel.style.display = p === 'Epic Games' ? 'flex' : 'none';
    ubisoftIdLabel.style.display = p === 'Ubisoft' ? 'flex' : 'none';
    exeLabel.style.display = (p === 'Microsoft' || p === 'Ubisoft' || p === 'Other') ? 'flex' : 'none';
    coverSteam.style.display = p === 'Steam' ? 'inline-flex' : 'none';
    robloxNote.style.display = p === 'Roblox' ? 'block' : 'none';
  }

  let saveTimer = null;
  function persistGame(extra) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const updated = {
        id: game.id,
        name: nameInput.value.trim() || game.name,
        platform: platform.value,
        steamAppId: steamId.value.trim(),
        epicAppName: epicName.value.trim(),
        ubisoftId: ubisoftId.value.trim(),
        exePath: exe.value,
        ...extra,
      };
      const games = await window.api.saveGame(updated);
      state.games = games;
      Object.assign(game, games.find(g => g.id === game.id));
      renderLibrary();
      const idx = state.games.findIndex(g => g.id === game.id);
      if (idx !== -1) thumbImg.classList.remove('loaded');
      if (idx !== -1) resolveCoverImage(thumbImg, state.games[idx]);
    }, 300);
  }

  [nameInput, steamId, epicName, ubisoftId].forEach(el => el.addEventListener('input', persistGame));
  platform.addEventListener('change', () => { updateFieldVisibility(); persistGame(); });
  exeBrowse.addEventListener('click', async () => {
    const picked = await window.api.pickFile([{ name: 'Executables', extensions: ['exe'] }]);
    if (picked) { exe.value = picked; persistGame(); }
  });
  coverPick.addEventListener('click', async () => {
    const dataUrl = await window.api.pickCoverImage();
    if (dataUrl) persistGame({ cover: dataUrl, coverSource: 'custom' });
  });
  coverSteam.addEventListener('click', async () => {
    if (!steamId.value.trim()) {
      coverFindStatus.className = 'cover-find-status status-error';
      coverFindStatus.textContent = 'set a Steam App ID first.';
      return;
    }
    coverSteam.disabled = true;
    coverFindStatus.className = 'cover-find-status';
    coverFindStatus.textContent = 'Fetching Steam store art…';
    const res = await window.api.resolveSteamArt(steamId.value.trim());
    coverSteam.disabled = false;
    if (res.success) {
      coverFindStatus.className = 'cover-find-status status-ok';
      coverFindStatus.textContent = '✓ Steam art applied.';
      persistGame({ cover: res.url, coverSource: 'steam' });
    } else {
      coverFindStatus.className = 'cover-find-status status-error';
      coverFindStatus.textContent = res.error;
    }
  });
  coverFindBtn.addEventListener('click', async () => {
    coverFindBtn.disabled = true;
    coverFindStatus.className = 'cover-find-status';
    coverFindStatus.textContent = `Searching Steam's catalog for "${nameInput.value.trim() || game.name}"…`;
    const res = await window.api.findCoverOnline(nameInput.value.trim() || game.name);
    coverFindBtn.disabled = false;
    if (res.success) {
      coverFindStatus.className = 'cover-find-status status-ok';
      coverFindStatus.textContent = `✓ Found art via "${res.matchedName}" — this only borrows box art, it doesn't change how the game launches.`;
      persistGame({ cover: res.imageUrl, coverSource: 'custom', coverAppId: res.appId });
    } else {
      coverFindStatus.className = 'cover-find-status status-error';
      coverFindStatus.textContent = res.error;
    }
  });

  bindDeleteConfirm(node.querySelector('.app-row-delete'), async () => {
    const res = await window.api.deleteGame(game.id);
    state.games = res.games;
    state.profiles = res.profiles;
    renderLibrary();
    closeEditGameModal();
    if (currentGameId === game.id) switchView('library');
  });

  return node;
}

// ---------------------------------------------------------------- settings: tool profiles
function refreshCategoryDatalist() {
  const datalist = document.getElementById('category-datalist');
  const categories = [...new Set(state.profiles.map(p => p.group).filter(Boolean))].sort();
  datalist.innerHTML = categories.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
}

function buildAppRow(profile) {
  const tpl = document.getElementById('tpl-app-row');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = profile.id;
  node.classList.add('expanded'); // always shown fully expanded — this row only ever lives inside its own edit modal now

  if (profile.hidden) node.classList.add('item-hidden');
  node.dataset.hidden = profile.hidden ? '1' : '';

  const nameInput = node.querySelector('.app-row-name');
  nameInput.value = profile.name;

  node.querySelector('.app-row-badge').textContent = profile.locked ? 'preset' : 'custom';

  const deleteBtn = node.querySelector('.app-row-delete');

  const hideBtn = node.querySelector('.app-row-hide');
  hideBtn.textContent = profile.hidden ? 'unhide' : 'hide';
  hideBtn.addEventListener('click', async () => {
    const profiles = await window.api.saveProfile({ id: profile.id, hidden: !profile.hidden });
    state.profiles = profiles;
    Object.assign(profile, profiles.find(p => p.id === profile.id));
    hideBtn.textContent = profile.hidden ? 'unhide' : 'hide';
    node.classList.toggle('item-hidden', !!profile.hidden);
    renderLibrary();
    if (currentGameId) {
      const game = state.games.find(g => g.id === currentGameId);
      if (game) renderGameTools(game);
    }
  });

  node.querySelector('.app-row-duplicate').addEventListener('click', async () => {
    const res = await window.api.duplicateProfile(profile.id);
    if (!res.success) return;
    state.profiles = res.profiles;
    renderLibrary();
    if (currentGameId) {
      const game = state.games.find(g => g.id === currentGameId);
      if (game) renderGameTools(game);
    }
    const newProfile = res.profiles.find(p => p.id === res.newId);
    if (newProfile) openEditToolModal(newProfile);
  });

  const fColor = node.querySelector('.f-color');
  const fGroup = node.querySelector('.f-group');
  const fMethod = node.querySelector('.f-method');
  const fPath = node.querySelector('.f-path');
  const fBrowse = node.querySelector('.f-browse');
  const fElevate = node.querySelector('.f-elevate');
  const fRetry = node.querySelector('.f-retry');
  const fGameSelect = node.querySelector('.f-game-select');
  const pathLabelText = node.querySelector('.f-path-label');

  fColor.value = profile.color;
  fGroup.value = profile.group || '';
  fMethod.value = profile.method;
  fPath.value = profile.targetPath || '';
  fElevate.value = profile.elevate;
  fRetry.checked = !!profile.retry;

  for (const g of state.games) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    fGameSelect.appendChild(opt);
  }
  fGameSelect.value = profile.gameId || '';
  updatePathLabel();

  // live preview so the point of color/category is seen, not explained
  const previewName = node.querySelector('.mini-card-name');
  const previewMethod = node.querySelector('.mini-card-method');
  const previewCard = node.querySelector('.mini-card');
  function updatePreview() {
    previewName.textContent = nameInput.value.trim() || profile.name;
    previewMethod.textContent = methodLabel(fMethod.value);
    node.style.setProperty('--card-accent', fColor.value);
    previewCard.style.setProperty('--card-accent', fColor.value);
  }
  updatePreview();

  function updatePathLabel() {
    const labelSpan = pathLabelText.firstChild;
    const text = fMethod.value === 'direct' ? 'Target file (.exe, .bat, .ahk, script...)'
      : fMethod.value === 'folder' ? 'Target folder (the runnable file inside may change name)'
      : 'Target archive (.zip / .7z / .rar)';
    labelSpan.textContent = text;
  }

  fMethod.addEventListener('change', () => { updatePathLabel(); updatePreview(); });
  nameInput.addEventListener('input', updatePreview);
  fColor.addEventListener('input', updatePreview);

  fBrowse.addEventListener('click', async () => {
    let picked;
    if (fMethod.value === 'folder') picked = await window.api.pickFolder();
    else if (fMethod.value === 'archive') picked = await window.api.pickFile([{ name: 'Archives', extensions: ['zip', '7z', 'rar'] }]);
    else picked = await window.api.pickFile([{ name: 'Executables & Scripts', extensions: LAUNCHABLE_EXTENSIONS }]);
    if (picked) { fPath.value = picked; persistRow(); }
  });

  let saveTimer = null;
  function persistRow() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const updated = {
        id: profile.id,
        name: nameInput.value.trim() || profile.name,
        color: fColor.value,
        group: fGroup.value.trim() || 'Custom',
        method: fMethod.value,
        targetPath: fPath.value,
        elevate: fElevate.value,
        retry: fRetry.checked,
        locked: profile.locked,
        gameId: fGameSelect.value,
      };
      const profiles = await window.api.saveProfile(updated);
      state.profiles = profiles;
      renderLibrary();
      refreshCategoryDatalist();
      const idx = state.profiles.findIndex(p => p.id === profile.id);
      if (idx !== -1) Object.assign(profile, state.profiles[idx]);
      if (currentGameId) {
        const game = state.games.find(g => g.id === currentGameId);
        if (game) renderGameTools(game);
      }
    }, 300);
  }

  [nameInput, fColor, fGroup, fMethod, fElevate, fGameSelect].forEach(el => {
    el.addEventListener('input', persistRow);
    el.addEventListener('change', persistRow);
  });
  fRetry.addEventListener('change', persistRow);

  bindDeleteConfirm(deleteBtn, async () => {
    const res = await window.api.deleteProfile(profile.id);
    if (res.success) {
      state.profiles = res.profiles;
      renderLibrary();
      if (currentGameId) {
        const game = state.games.find(g => g.id === currentGameId);
        if (game) renderGameTools(game);
      }
      closeEditToolModal();
    }
  });

  return node;
}

document.getElementById('btn-add-app').addEventListener('click', async () => {
  const newProfile = await window.api.addProfile({});
  state.profiles.push(newProfile);
  renderLibrary();
  openEditToolModal(newProfile);
});

// ---------------------------------------------------------------- drag-to-reorder
// Uses SortableJS (vendored via node_modules, loaded in index.html) instead
// of a hand-rolled HTML5 drag implementation — a from-scratch version kept
// hitting edge cases (position math corrupted by in-flight animations,
// dragover firing faster than layout could settle) that a mature,
// battle-tested library already handles correctly, including auto-scroll
// near the container edges and nested sortable lists (categories that are
// themselves reorderable, each also containing a reorderable+cross-group
// grid of tool cards).
//
// #game-tools hosts two independent Sortable instances at once: one on
// #game-tools itself for whole-category reordering (handle: 'h3', so
// grabbing a card never triggers it), and one per .group-cards grid for the
// tool cards inside, all sharing the same `group` name so a card can be
// dragged from one category into another. The per-category ones are
// recreated every renderGameTools() call since that rebuilds the grids from
// scratch; the category-level one is created once at boot since #game-tools
// itself is never recreated.
let toolCardSortables = [];

function attachToolCardSortables(onReorder) {
  for (const s of toolCardSortables) s.destroy();
  toolCardSortables = [...document.querySelectorAll('#game-tools .group-cards')].map(groupEl =>
    Sortable.create(groupEl, {
      group: 'tool-cards',
      animation: 150,
      onEnd: (evt) => onReorder({
        movedId: evt.item.dataset.id,
        newGroup: evt.to.dataset.group,
      }),
    })
  );
}

// ---------------------------------------------------------------- boot
(async function init() {
  state = await window.api.getState();
  if (!Array.isArray(state.games)) state.games = [];
  renderThemePresets();
  applyTheme(state.theme);
  wireThemeInputs();
  refreshCategoryDatalist();
  renderLibrary();

  Sortable.create(document.getElementById('game-grid'), {
    animation: 150,
    scroll: document.querySelector('.content'),
    onEnd: async () => {
      const ids = [...document.querySelectorAll('#game-grid .game-card')].map(el => el.dataset.id);
      state.games = await window.api.reorderGames(ids);
    },
  });

  // whole-category reorder — grabbed by its <h3> handle, independent of the
  // per-category tool-card Sortables (attachToolCardSortables, wired inside
  // renderGameTools since those grids get rebuilt on every edit/hide/add).
  // Wired once here since #game-tools itself is never recreated. There's no
  // separate "category order" field to persist: a category's position is
  // just wherever its tools sit in the profiles array relative to other
  // categories' tools, so reordering categories means re-flattening every
  // visible tool for this game into the new category sequence (each
  // category's own internal tool order carried over unchanged) and
  // persisting that as the new array order.
  Sortable.create(document.getElementById('game-tools'), {
    animation: 150,
    handle: 'h3',
    draggable: '.group-block',
    scroll: document.querySelector('.content'),
    onEnd: async () => {
      const game = state.games.find(g => g.id === currentGameId);
      if (!game) return;
      const groupNamesInOrder = [...document.querySelectorAll('#game-tools .group-block')].map(el => el.dataset.id);
      const visible = state.profiles.filter(p => p.gameId === game.id && !p.hidden);
      const flatIds = [];
      for (const groupName of groupNamesInOrder) {
        for (const p of visible) {
          if ((p.group || 'Custom') === groupName) flatIds.push(p.id);
        }
      }
      state.profiles = await window.api.reorderProfiles(flatIds);
    },
  });
})();
