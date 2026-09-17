const { app, BrowserWindow, ipcMain, shell, screen, Menu, globalShortcut, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { exec } = require('child_process');

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const AUTH_PORT = 8888;
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read'
].join(' ');

const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

let mainWindow;

function createWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 220,
    height: 32,
    x: screenW - 240,
    y: 20,
    hasShadow: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log(`[renderer] ${message}`);
  });

  // Windows can silently drop the topmost flag when the window is clicked/blurred.
  // Reassert it on every blur and on a slow interval as a safety net.
  mainWindow.on('blur', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isAlwaysOnTop()) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 2000);
}

function isSpotifyRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq Spotify.exe" /FO CSV /NH', (err, stdout) => {
      if (err || !stdout) return resolve(false);
      resolve(stdout.toLowerCase().includes('spotify.exe'));
    });
  });
}

async function ensureSpotifyRunning() {
  const running = await isSpotifyRunning();
  if (!running) {
    shell.openExternal('spotify:');
  }
}

function enableAutoStart() {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  } else {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: [path.resolve(__dirname)]
    });
  }
}

function registerFocusHotkey() {
  const accel = 'Control+Alt+S';
  const ok = globalShortcut.register(accel, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });
  if (!ok) console.error(`Failed to register global hotkey ${accel} (likely already used by another app)`);
}

app.whenReady().then(() => {
  createWindow();
  enableAutoStart();
  ensureSpotifyRunning();
  registerFocusHotkey();
  if (app.isPackaged) checkForUpdates(false);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ---------- Auto-update (electron-updater, GitHub releases) ----------
let updateCheckInProgress = false;

autoUpdater.on('update-not-available', () => {
  if (updateCheckInProgress) {
    dialog.showMessageBox(mainWindow, { message: "You're on the latest version.", title: 'Spotify Widget' });
  }
  updateCheckInProgress = false;
});

autoUpdater.on('error', (err) => {
  if (updateCheckInProgress) {
    dialog.showMessageBox(mainWindow, { message: `Update check failed: ${err.message || err}`, title: 'Spotify Widget' });
  }
  updateCheckInProgress = false;
});

autoUpdater.on('update-downloaded', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    title: 'Update ready',
    message: 'A new version of Spotify Widget has been downloaded. Restart now to install it?'
  });
  if (response === 0) autoUpdater.quitAndInstall();
});

function checkForUpdates(manual) {
  updateCheckInProgress = !!manual;
  autoUpdater.checkForUpdates().catch(() => {});
}

app.on('window-all-closed', () => {
  app.quit();
});

// ---------- PKCE helpers ----------
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

let pendingAuth = null;

function startAuthServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html');
      if (error) {
        res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end('<h2>Spotify connected. You can close this tab.</h2>');
      server.close();
      resolve(code);
    });
    server.listen(AUTH_PORT, '127.0.0.1');
  });
}

async function exchangeCodeForToken(code, verifier, clientId) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

async function refreshAccessToken(cfg) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.refresh_token,
    client_id: cfg.client_id
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  cfg.access_token = data.access_token;
  cfg.expires_at = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) cfg.refresh_token = data.refresh_token;
  saveConfig(cfg);
  return cfg;
}

async function getValidAccessToken() {
  const cfg = loadConfig();
  if (!cfg.access_token || !cfg.refresh_token) throw new Error('Not authenticated');
  if (Date.now() > cfg.expires_at - 30000) {
    await refreshAccessToken(cfg);
    return loadConfig().access_token;
  }
  return cfg.access_token;
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => {
  const cfg = loadConfig();
  return { hasClientId: !!cfg.client_id, isAuthed: !!cfg.refresh_token };
});

ipcMain.handle('config:setClientId', (evt, clientId) => {
  const cfg = loadConfig();
  cfg.client_id = clientId.trim();
  saveConfig(cfg);
  return true;
});

ipcMain.handle('auth:start', async () => {
  const cfg = loadConfig();
  if (!cfg.client_id) throw new Error('No client ID set');
  const { verifier, challenge } = generatePKCE();
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
  const codePromise = startAuthServer();
  shell.openExternal(authUrl);
  const code = await codePromise;
  const tokenData = await exchangeCodeForToken(code, verifier, cfg.client_id);
  cfg.access_token = tokenData.access_token;
  cfg.refresh_token = tokenData.refresh_token;
  cfg.expires_at = Date.now() + tokenData.expires_in * 1000;
  saveConfig(cfg);
  return true;
});

ipcMain.handle('auth:reset', () => {
  saveConfig({});
  return true;
});

ipcMain.on('show-context-menu', (event) => {
  const template = [
    {
      label: 'Restart Spotify',
      click: () => {
        exec('taskkill /F /IM Spotify.exe', () => {
          setTimeout(() => shell.openExternal('spotify:'), 1500);
        });
      }
    },
    {
      label: 'Reconnect Spotify',
      click: () => {
        const cfg = loadConfig();
        delete cfg.access_token;
        delete cfg.refresh_token;
        delete cfg.expires_at;
        saveConfig(cfg);
        event.sender.send('force-setup');
      }
    },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => checkForUpdates(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ];
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
});

async function spotifyFetch(endpoint, options = {}) {
  const token = await getValidAccessToken();
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  return res;
}

// A freshly-launched Spotify client isn't a controllable "active device" on
// Spotify Connect until playback has started on it at least once. Find any
// available device and transfer control to it so commands work immediately.
async function ensureActiveDevice() {
  try {
    const res = await spotifyFetch('/me/player/devices');
    if (!res.ok) return null;
    const data = await res.json();
    const devices = data.devices || [];
    if (!devices.length) return null;
    const active = devices.find(d => d.is_active);
    if (active) return active.id;
    const target = devices.find(d => d.type === 'Computer') || devices[0];
    await spotifyFetch('/me/player', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [target.id], play: false })
    });
    return target.id;
  } catch {
    return null;
  }
}

// Wraps a playback-control call: if it fails because there's no active
// device yet, activate one and retry once.
async function spotifyControlFetch(endpoint, options = {}) {
  let res = await spotifyFetch(endpoint, options);
  if (res.status === 404 || res.status === 403) {
    const deviceId = await ensureActiveDevice();
    if (deviceId) {
      res = await spotifyFetch(endpoint, options);
    }
  }
  return res;
}

ipcMain.handle('spotify:getState', async () => {
  try {
    const res = await spotifyFetch('/me/player');
    if (res.status === 204) return { noPlayback: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      isPlaying: data.is_playing,
      trackName: data.item ? data.item.name : '',
      artistName: data.item ? data.item.artists.map(a => a.name).join(', ') : '',
      albumArt: data.item && data.item.album.images.length ? data.item.album.images[0].url : null,
      volumePercent: data.device ? data.device.volume_percent : 50,
      progressMs: data.progress_ms,
      durationMs: data.item ? data.item.duration_ms : 0,
      deviceName: data.device ? data.device.name : null
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('spotify:playPause', async (evt, isPlaying) => {
  const res = await spotifyControlFetch(isPlaying ? '/me/player/pause' : '/me/player/play', { method: 'PUT' });
  return res.ok || res.status === 204;
});

ipcMain.handle('spotify:next', async () => {
  const res = await spotifyControlFetch('/me/player/next', { method: 'POST' });
  return res.ok || res.status === 204;
});

ipcMain.handle('spotify:previous', async () => {
  const res = await spotifyControlFetch('/me/player/previous', { method: 'POST' });
  return res.ok || res.status === 204;
});

ipcMain.handle('spotify:setVolume', async (evt, percent) => {
  const res = await spotifyControlFetch(`/me/player/volume?volume_percent=${Math.round(percent)}`, { method: 'PUT' });
  return res.ok || res.status === 204;
});

ipcMain.handle('spotify:getLiked', async () => {
  try {
    const res = await spotifyFetch('/me/tracks?limit=25');
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      items: data.items
        .filter(i => i.track)
        .map(i => ({
          id: i.track.id,
          name: i.track.name,
          artist: i.track.artists.map(a => a.name).join(', '),
          uri: i.track.uri,
          image: i.track.album && i.track.album.images.length ? i.track.album.images[i.track.album.images.length - 1].url : null
        }))
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('spotify:getPlaylists', async () => {
  try {
    const res = await spotifyFetch('/me/playlists?limit=30');
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      items: data.items.map(p => ({
        id: p.id,
        name: p.name,
        uri: p.uri,
        image: p.images && p.images.length ? p.images[p.images.length - 1].url : null
      }))
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('spotify:getQueue', async () => {
  try {
    const res = await spotifyFetch('/me/player/queue');
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      items: (data.queue || []).slice(0, 25).map(t => ({
        id: t.id,
        name: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        uri: t.uri,
        image: t.album && t.album.images.length ? t.album.images[t.album.images.length - 1].url : null
      }))
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('spotify:playContext', async (evt, uri) => {
  const res = await spotifyControlFetch('/me/player/play', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context_uri: uri })
  });
  return res.ok || res.status === 204;
});

ipcMain.handle('spotify:playTrack', async (evt, uri) => {
  // Spotify's desktop client currently mishandles PUT /me/player/play with a
  // bare `uris` list (it stops playback instead of starting the track), while
  // context_uri playback and next/previous both work fine. Work around it by
  // queuing the track and skipping to it instead of "playing" it directly.
  const queueRes = await spotifyControlFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
  if (queueRes.ok || queueRes.status === 204 || queueRes.status === 200) {
    const nextRes = await spotifyControlFetch('/me/player/next', { method: 'POST' });
    if (nextRes.ok || nextRes.status === 204) return true;
  }
  // Fallback for a fully idle player (nothing to skip from yet).
  const res = await spotifyControlFetch('/me/player/play', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri] })
  });
  return res.ok || res.status === 204;
});

async function resolvePlaylistByName(query) {
  const res = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=playlist&limit=10`);
  if (!res.ok) return null;
  const data = await res.json();
  const items = data.playlists && data.playlists.items ? data.playlists.items.filter(Boolean) : [];
  return items.length ? items[0] : null;
}

ipcMain.handle('spotify:getHot', async () => {
  try {
    const res = await spotifyFetch(`/search?q=${encodeURIComponent('Top Hits 2026')}&type=playlist&limit=10`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    const items = (data.playlists && data.playlists.items ? data.playlists.items : []).filter(Boolean);
    return {
      items: items.map(p => ({
        id: p.id,
        name: p.name,
        uri: p.uri,
        image: p.images && p.images.length ? p.images[p.images.length - 1].url : null
      }))
    };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('spotify:playGenre', async (evt, genre) => {
  try {
    const playlist = await resolvePlaylistByName(genre);
    if (!playlist) return false;
    const res = await spotifyControlFetch('/me/player/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context_uri: playlist.uri })
    });
    return res.ok || res.status === 204;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('app:openSpotify', () => {
  shell.openExternal('spotify:');
  return true;
});

ipcMain.handle('window:close', () => {
  app.quit();
});

ipcMain.handle('window:minimize', () => {
  mainWindow.minimize();
});

ipcMain.handle('window:resize', (evt, { width, height }) => {
  const [x, y] = mainWindow.getPosition();
  const [oldWidth] = mainWindow.getSize();
  // Keep the window's right edge (and top edge) fixed in place, wherever
  // the user has dragged it, instead of snapping back to a fixed position.
  const newX = x + (oldWidth - width);
  mainWindow.setBounds({ x: newX, y, width, height });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
});
