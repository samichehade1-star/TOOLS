const setupView = document.getElementById('setup-view');
const playerView = document.getElementById('player-view');
const stepClientId = document.getElementById('step-clientid');
const stepAuth = document.getElementById('step-auth');
const clientIdInput = document.getElementById('client-id-input');
const saveClientIdBtn = document.getElementById('save-client-id-btn');
const loginBtn = document.getElementById('login-btn');
const setupStatus = document.getElementById('setup-status');

const playBtn = document.getElementById('play-btn');
const nextBtn = document.getElementById('next-btn');
const plusBtn = document.getElementById('plus-btn');
const djBtn = document.getElementById('dj-btn');
const volSlider = document.getElementById('vol-slider');
const volIcon = document.getElementById('vol-icon');
const bar = document.querySelector('.bar');

const popupPanel = document.getElementById('popup-panel');
const popupList = document.getElementById('popup-list');
const popupClose = document.getElementById('popup-close');
const tabLiked = document.getElementById('tab-liked');
const tabPlaylists = document.getElementById('tab-playlists');
const tabQueue = document.getElementById('tab-queue');
const tabHot = document.getElementById('tab-hot');
const tabGenre = document.getElementById('tab-genre');

const GENRES = ['Pop', 'Hip-Hop', 'Rock', 'EDM', 'R&B', 'Latin', 'K-Pop', 'Indie', 'Chill', 'Country', 'Metal', 'Jazz'];

const COMPACT_SIZE = { width: 250, height: 32 };
const EXPANDED_SIZE = { width: 260, height: 320 };
const SETUP_SIZE = { width: 260, height: 190 };

let currentIsPlaying = false;
let pollTimer = null;
let volumeDragging = false;
let lastVolumeSendAt = 0;
let popupOpen = false;
let activeTab = 'liked';
let playlistsCache = null;
let likedCache = null;

function showSetup(hasClientId) {
  playerView.classList.add('hidden');
  setupView.classList.remove('hidden');
  window.api.resizeWindow(SETUP_SIZE.width, SETUP_SIZE.height);
  if (hasClientId) {
    stepClientId.classList.add('hidden');
    stepAuth.classList.remove('hidden');
  } else {
    stepClientId.classList.remove('hidden');
    stepAuth.classList.add('hidden');
  }
}

function showPlayer() {
  setupView.classList.add('hidden');
  playerView.classList.remove('hidden');
  window.api.resizeWindow(COMPACT_SIZE.width, COMPACT_SIZE.height);
  startPolling();
}

async function init() {
  const cfg = await window.api.getConfig();
  if (cfg.isAuthed) {
    showPlayer();
  } else {
    showSetup(cfg.hasClientId);
  }
}

saveClientIdBtn.addEventListener('click', async () => {
  const id = clientIdInput.value.trim();
  if (!id) {
    setupStatus.textContent = 'Please enter a Client ID.';
    return;
  }
  await window.api.setClientId(id);
  setupStatus.textContent = '';
  stepClientId.classList.add('hidden');
  stepAuth.classList.remove('hidden');
});

loginBtn.addEventListener('click', async () => {
  setupStatus.style.color = '#ccc';
  setupStatus.textContent = 'Opening browser for login...';
  try {
    await window.api.startAuth();
    setupStatus.textContent = 'Connected!';
    setTimeout(showPlayer, 400);
  } catch (e) {
    setupStatus.style.color = '#ff6b6b';
    setupStatus.textContent = 'Login failed: ' + e.message;
  }
});

bar.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showContextMenu();
});

window.api.onForceSetup(() => {
  if (pollTimer) clearInterval(pollTimer);
  playlistsCache = null;
  likedCache = null;
  showSetup(true);
});

playBtn.addEventListener('click', async () => {
  const ok = await window.api.playPause(currentIsPlaying);
  if (ok) {
    currentIsPlaying = !currentIsPlaying;
    updatePlayIcon();
  }
});

nextBtn.addEventListener('click', () => window.api.next());
djBtn.addEventListener('click', () => window.api.openSpotify());

volSlider.addEventListener('input', () => {
  volumeDragging = true;
  const now = Date.now();
  if (now - lastVolumeSendAt > 250) {
    lastVolumeSendAt = now;
    window.api.setVolume(volSlider.value);
  }
});
volSlider.addEventListener('change', () => {
  window.api.setVolume(volSlider.value);
  setTimeout(() => { volumeDragging = false; }, 500);
});

function updatePlayIcon() {
  playBtn.innerHTML = currentIsPlaying ? '&#9208;' : '&#9654;';
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, 2000);
}

async function poll() {
  const state = await window.api.getState();
  if (!state || state.error || state.noPlayback) return;
  currentIsPlaying = state.isPlaying;
  updatePlayIcon();
  if (!volumeDragging) {
    volSlider.value = state.volumePercent;
  }
  volIcon.innerHTML = state.volumePercent === 0 ? '&#128263;' : '&#128266;';
}

// ---------- Popup: playlists / queue ----------
plusBtn.addEventListener('click', () => {
  if (popupOpen) {
    closePopup();
  } else {
    openPopup();
  }
});
popupClose.addEventListener('click', closePopup);

function openPopup() {
  popupOpen = true;
  popupPanel.classList.remove('hidden');
  window.api.resizeWindow(EXPANDED_SIZE.width, EXPANDED_SIZE.height);
  loadTab(activeTab);
}

function closePopup() {
  popupOpen = false;
  popupPanel.classList.add('hidden');
  window.api.resizeWindow(COMPACT_SIZE.width, COMPACT_SIZE.height);
}

tabLiked.addEventListener('click', () => switchTab('liked'));
tabPlaylists.addEventListener('click', () => switchTab('playlists'));
tabQueue.addEventListener('click', () => switchTab('queue'));
tabHot.addEventListener('click', () => switchTab('hot'));
tabGenre.addEventListener('click', () => switchTab('genre'));

function switchTab(tab) {
  activeTab = tab;
  tabLiked.classList.toggle('active', tab === 'liked');
  tabPlaylists.classList.toggle('active', tab === 'playlists');
  tabQueue.classList.toggle('active', tab === 'queue');
  tabHot.classList.toggle('active', tab === 'hot');
  tabGenre.classList.toggle('active', tab === 'genre');
  loadTab(tab);
}

function makeTrackItem(item, onClick) {
  const div = document.createElement('div');
  div.className = 'popup-item';
  const sub = item.artist ? `<div class="p-sub">${escapeHtml(item.artist)}</div>` : '';
  div.innerHTML = `<img src="${item.image || ''}" /><div class="p-text"><div class="p-name">${escapeHtml(item.name)}</div>${sub}</div>`;
  div.addEventListener('click', onClick);
  return div;
}

async function loadTab(tab) {
  if (tab === 'genre') {
    renderGenreGrid();
    return;
  }
  popupList.innerHTML = '<div class="popup-empty">Loading…</div>';
  if (tab === 'liked') {
    if (!likedCache) {
      const res = await window.api.getLiked();
      if (res.error) {
        popupList.innerHTML = `<div class="popup-empty">${res.error}</div>`;
        return;
      }
      likedCache = res.items;
    }
    renderList(likedCache, (item) => makeTrackItem(item, async () => {
      await window.api.playTrack(item.uri);
      closePopup();
    }));
  } else if (tab === 'playlists') {
    if (!playlistsCache) {
      const res = await window.api.getPlaylists();
      if (res.error) {
        popupList.innerHTML = `<div class="popup-empty">${res.error}</div>`;
        return;
      }
      playlistsCache = res.items;
    }
    renderList(playlistsCache, (item) => makeTrackItem(item, async () => {
      await window.api.playContext(item.uri);
      closePopup();
    }));
  } else if (tab === 'queue') {
    const res = await window.api.getQueue();
    if (res.error) {
      popupList.innerHTML = `<div class="popup-empty">${res.error}</div>`;
      return;
    }
    renderList(res.items, (item) => makeTrackItem(item, async () => {
      await window.api.playTrack(item.uri);
      closePopup();
    }));
  } else if (tab === 'hot') {
    const res = await window.api.getHot();
    if (res.error) {
      popupList.innerHTML = `<div class="popup-empty">${res.error}</div>`;
      return;
    }
    renderList(res.items, (item) => makeTrackItem(item, async () => {
      await window.api.playContext(item.uri);
      closePopup();
    }));
  }
}

function renderGenreGrid() {
  popupList.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'genre-grid';
  GENRES.forEach(genre => {
    const chip = document.createElement('div');
    chip.className = 'genre-chip';
    chip.textContent = genre;
    chip.addEventListener('click', async () => {
      chip.style.opacity = '0.5';
      const ok = await window.api.playGenre(genre);
      if (ok) {
        closePopup();
      } else {
        chip.style.opacity = '1';
        chip.textContent = 'Not found';
        setTimeout(() => { chip.textContent = genre; }, 1200);
      }
    });
    grid.appendChild(chip);
  });
  popupList.appendChild(grid);
}

function renderList(items, makeItem) {
  popupList.innerHTML = '';
  if (!items || !items.length) {
    popupList.innerHTML = '<div class="popup-empty">Nothing to show</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach(item => frag.appendChild(makeItem(item)));
  popupList.appendChild(frag);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ---------- Idle dimming ----------
const appEl = document.getElementById('app');
const IDLE_MS = 20000;
let idleTimer = null;

function resetIdleTimer() {
  appEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!popupOpen) appEl.classList.add('idle');
  }, IDLE_MS);
}

document.addEventListener('mousemove', resetIdleTimer);
document.addEventListener('mousedown', resetIdleTimer);
document.addEventListener('wheel', resetIdleTimer);
resetIdleTimer();

init();
