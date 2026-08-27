// main.js — electron main process: settings, launch engine, IPC

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');
const pathTo7zip = sevenBin.path7za;
const { createExtractorFromFile } = require('node-unrar-js');
const gameDetect = require('./gameDetect');

process.setMaxListeners(20);
app.setName('LaunchPad X');

// Anything you'd normally just double-click to run — not just .exe. Windows
// (and PowerShell's Start-Process, which the launch engine below uses)
// already resolves any of these through the same file-association/ShellExecute
// path a real double-click would use, so no per-type launch logic is needed —
// only the "which files count as a launch target" detection has to widen.
const LAUNCHABLE_EXTENSIONS = ['exe', 'bat', 'cmd', 'ahk', 'vbs', 'vbe', 'ps1', 'com', 'scr', 'msi'];
function isLaunchableFile(name) {
    const ext = name.toLowerCase().split('.').pop();
    return LAUNCHABLE_EXTENSIONS.includes(ext);
}

// --- paths ---
const appDataPath = app.getPath('userData');
const settingsFilePath = path.join(appDataPath, 'settings.json');
const debugLogPath = path.join(appDataPath, 'launch-debug.log');

let mainWindow;

// --- crash reporter ---
process.on('uncaughtException', (error) => {
    try {
        fs.appendFileSync(debugLogPath, `\n[uncaught] ${new Date().toISOString()} ${error.stack || error}\n`);
    } catch { /* best effort */ }
    dialog.showErrorBox('unexpected error', `something went wrong. a log was saved to:\n${debugLogPath}`);
});

async function appendDebugLog(message) {
    try { await fs.appendFile(debugLogPath, `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
}

function logToConsole(message, type = 'info') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-message', { message, type, timestamp: new Date().toLocaleTimeString() });
    }
}

function uid() {
    return crypto.randomBytes(6).toString('hex');
}

// Reorders only the items named in `orderedVisibleIds` (drag-and-drop only
// ever sees the currently-visible subset), leaving any hidden/masked items
// exactly where they already were in the array instead of bunching them all
// at the end.
function applyPartialReorder(fullArray, orderedVisibleIds) {
    const idSet = new Set(orderedVisibleIds);
    const queue = [...orderedVisibleIds];
    const byId = new Map(fullArray.map(item => [item.id, item]));
    return fullArray.map(item => (idSet.has(item.id) ? byId.get(queue.shift()) : item));
}

// --- default data: seeded preset profiles, generalized from the three
// launch protocols already proven out in the FMP / Nyxia / Visenya tools,
// pre-attached to a seeded "Dead by Daylight" library entry since that's
// what all of them target — rename/reassign/delete freely, nothing is locked
// at the game level, only each tool's method/retry contract is ---
function defaultGames() {
    return [
        { id: 'dbd', name: 'Dead by Daylight', platform: 'Steam', cover: '', coverSource: 'steam', coverAppId: '', steamAppId: '381210', epicAppName: '', ubisoftId: '', xboxLaunchId: '', exePath: '', detectedName: '' },
    ];
}

function defaultProfiles() {
    return [
        { id: 'fmp-spoofer', name: 'FMP Spoofer', icon: '🎭', color: '#38bdf8', group: 'FMP', method: 'archive', elevate: 'prompt', retry: true, targetPath: '', locked: true, gameId: 'dbd' },
        { id: 'fmp-trainer', name: 'FMP Trainer', icon: '🛠️', color: '#38bdf8', group: 'FMP', method: 'archive', elevate: 'prompt', retry: true, targetPath: '', locked: true, gameId: 'dbd' },
        { id: 'nyxia-spoofer', name: 'Nyxia Spoofer', icon: '👻', color: '#a78bfa', group: 'Nyxia', method: 'folder', elevate: 'silent', retry: false, targetPath: '', locked: true, gameId: 'dbd' },
        { id: 'nyxia-pakbypass', name: 'Nyxia Pak Bypass', icon: '🔓', color: '#a78bfa', group: 'Nyxia', method: 'folder', elevate: 'silent', retry: false, targetPath: '', locked: true, gameId: 'dbd' },
        { id: 'nyxia-unlocker', name: 'Nyxia Unlocker', icon: '🗝️', color: '#a78bfa', group: 'Nyxia', method: 'folder', elevate: 'silent', retry: false, targetPath: '', locked: true, gameId: 'dbd' },
        { id: 'visenya-x', name: 'Visenya X', icon: '🐲', color: '#fbbf24', group: 'Visenya', method: 'direct', elevate: 'silent', retry: false, targetPath: '', locked: true, gameId: '' },
        { id: 'visenya-y', name: 'Visenya S', icon: '🐉', color: '#fbbf24', group: 'Visenya', method: 'direct', elevate: 'silent', retry: false, targetPath: '', locked: true, gameId: '' },
    ];
}

function defaultGameShape() {
    return { id: '', name: 'New Game', platform: 'Steam', cover: '', coverSource: 'steam', coverAppId: '', steamAppId: '', epicAppName: '', ubisoftId: '', xboxLaunchId: '', exePath: '', detectedName: '', hidden: false };
}

function defaultTheme() {
    return {
        preset: 'nebula',
        accent: '#8b5cf6',
        accent2: '#38bdf8',
        bgFrom: '#0b0e17',
        bgTo: '#161227',
        cardOpacity: 0.55,
    };
}

let appState = {
    profiles: defaultProfiles(),
    games: defaultGames(),
    theme: defaultTheme(),
    windowBounds: { width: 1180, height: 780 },
};

const backupFilePath = settingsFilePath + '.bak';
const tmpFilePath = settingsFilePath + '.tmp';

async function persistState() {
    const json = JSON.stringify(appState, null, 2);
    // write-then-rename rather than writing settingsFilePath directly: a
    // rename is a single atomic filesystem op, so a crash/kill mid-save
    // can only ever strand the .tmp file — it can't leave settings.json
    // itself half-written and unparseable.
    await fs.writeFile(tmpFilePath, json, 'utf8');
    await fs.rename(tmpFilePath, settingsFilePath);
    // refresh the backup only after the primary write above is confirmed
    // in place, so .bak always holds a complete, previously-valid snapshot
    // — never a copy of something that failed to write correctly.
    await fs.copyFile(settingsFilePath, backupFilePath).catch(() => {});
}

// strips a leading UTF-8 BOM (﻿) before parsing — JSON.parse throws on
// it outright. Node's own fs.writeFile never adds one, but external editors
// and tools (PowerShell's `Set-Content -Encoding utf8`, notably) do, and one
// slipping in used to be enough to make this file read as "corrupt" and fall
// straight through to the hardcoded factory defaults below.
async function readStateFile(filePath) {
    if (!(await fs.pathExists(filePath))) return null;
    const raw = await fs.readFile(filePath, 'utf8');
    const stripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    if (!stripped.trim()) return null; // empty/truncated — treat as unreadable, not "valid empty state"
    return JSON.parse(stripped);
}

async function loadState() {
    await fs.ensureDir(appDataPath);
    let data = null;
    let usedBackup = false;
    try {
        data = await readStateFile(settingsFilePath);
    } catch (error) {
        logToConsole(`settings.json is unreadable (${error.message}) — trying the backup copy...`, 'error');
    }
    if (!data) {
        try {
            data = await readStateFile(backupFilePath);
            usedBackup = !!data;
        } catch (error) {
            logToConsole(`backup settings are also unreadable (${error.message})`, 'error');
        }
    }
    if (data) {
        appState = {
            ...appState,
            ...data,
            theme: { ...defaultTheme(), ...(data.theme || {}) },
        };
        if (!Array.isArray(appState.games)) appState.games = defaultGames();
        // fold in any newly-added presets for users upgrading from an older
        // seed list, without clobbering paths/settings they've already set
        const existingIds = new Set(appState.profiles.map(p => p.id));
        for (const preset of defaultProfiles()) {
            if (!existingIds.has(preset.id)) appState.profiles.push(preset);
        }
        if (usedBackup) {
            logToConsole('the main settings file failed to load — recovered your library and tools from the backup copy instead.', 'success');
        }
        // always resave after a successful load, not just on the backup path:
        // this both heals a primary file that needed a cosmetic fix (a BOM
        // some other tool added, e.g.) and guarantees .bak exists and is
        // fresh right after boot, instead of only whenever some later save
        // happens to fire — a fresh install with no saves yet would
        // otherwise have no backup at all.
        await persistState();
    } else {
        // only reachable on a genuine first run, or if both the primary file
        // and its backup are missing/corrupt — never on a routine parse
        // hiccup, since the .bak fallback above catches that case first.
        await persistState();
    }
}

function getProfile(id) {
    return appState.profiles.find(p => p.id === id);
}

function getGame(id) {
    return appState.games.find(g => g.id === id);
}

// =====================================================================
// window chrome
// =====================================================================

// The window opens at exactly the splash video's square size — no app chrome
// or background visible around it — then grows to the real app size once
// the intro finishes (see the 'splash-finished' handler below). Matches the
// square crop/frame the splash video is shown in (styles.css .splash-video-frame).
const SPLASH_WINDOW_SIZE = 620;
let inSplash = true;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: SPLASH_WINDOW_SIZE,
        height: SPLASH_WINDOW_SIZE,
        resizable: false,
        frame: false,
        backgroundColor: appState.theme.bgFrom || '#0b0e17',
        // deliberately NOT show:false + wait-for-ready-to-show here: a hidden
        // window's video isn't paced to the display's real refresh rate, so
        // the splash video was blasting through its whole 10s in the
        // background almost instantly, finishing before the window ever
        // appeared. backgroundColor above already prevents any white flash,
        // so showing immediately is safe.
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
    });

    Menu.setApplicationMenu(null);
    mainWindow.loadFile('index.html');

    let resizeTimer = null;
    mainWindow.on('resize', () => {
        if (inSplash) return; // ignore the programmatic splash->app resize itself
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
            if (mainWindow.isDestroyed()) return;
            const [width, height] = mainWindow.getSize();
            appState.windowBounds = { width, height };
            await persistState();
        }, 500);
    });
}

ipcMain.on('splash-finished', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !inSplash) return;
    inSplash = false;
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(980, 640);
    mainWindow.setSize(appState.windowBounds.width || 1180, appState.windowBounds.height || 780, true);
    mainWindow.center();
});

app.whenReady().then(async () => {
    await loadState();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.on('maximize-window', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow && mainWindow.close());

// =====================================================================
// dialogs
// =====================================================================

ipcMain.handle('pick-folder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return canceled ? null : filePaths[0];
});

ipcMain.handle('pick-file', async (event, filters) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: filters || [{ name: 'Executables & Scripts', extensions: LAUNCHABLE_EXTENSIONS }, { name: 'All Files', extensions: ['*'] }],
    });
    return canceled ? null : filePaths[0];
});

// =====================================================================
// settings / profile CRUD
// =====================================================================

ipcMain.handle('get-state', () => appState);

// =====================================================================
// auto-update (electron-updater, GitHub releases)
// =====================================================================
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateStatus(status, extra = {}) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-status', { status, ...extra });
    }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err == null ? 'unknown error' : (err.message || String(err)) }));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', () => sendUpdateStatus('downloaded'));

ipcMain.handle('check-for-updates', async () => {
    try { await autoUpdater.checkForUpdates(); }
    catch (err) { sendUpdateStatus('error', { message: err.message || String(err) }); }
});

ipcMain.handle('download-update', async () => {
    try { await autoUpdater.downloadUpdate(); }
    catch (err) { sendUpdateStatus('error', { message: err.message || String(err) }); }
});

ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('save-theme', async (event, theme) => {
    appState.theme = { ...appState.theme, ...theme };
    await persistState();
    return appState.theme;
});

ipcMain.handle('save-profile', async (event, profile) => {
    const idx = appState.profiles.findIndex(p => p.id === profile.id);
    if (idx === -1) {
        appState.profiles.push({ ...profile, id: profile.id || uid() });
    } else {
        // presets are fully editable, including method/retry — "locked" is now
        // purely the "preset" vs "custom" badge label, not a restriction
        appState.profiles[idx] = { ...appState.profiles[idx], ...profile };
    }
    await persistState();
    return appState.profiles;
});

ipcMain.handle('delete-profile', async (event, id) => {
    appState.profiles = appState.profiles.filter(p => p.id !== id);
    await persistState();
    return { success: true, profiles: appState.profiles };
});

ipcMain.handle('add-profile', async (event, profile) => {
    const newProfile = {
        id: uid(),
        name: 'New Tool',
        icon: '🚀',
        color: '#34d399',
        group: 'Custom',
        method: 'direct',
        elevate: 'none',
        retry: false,
        targetPath: '',
        locked: false,
        gameId: '',
        hidden: false,
        ...profile,
    };
    appState.profiles.push(newProfile);
    await persistState();
    return newProfile;
});

// A duplicate is always a free-standing custom copy, so it can be pointed at
// a different install without touching the source. `targetGameId` lets the
// "+ Add Tool" picker reuse an existing tool's config directly onto the game
// you're currently on; omitted, it just copies the source's own game (the
// plain "duplicate" button case).
ipcMain.handle('duplicate-profile', async (event, id, targetGameId) => {
    const source = getProfile(id);
    if (!source) return { success: false, error: 'profile not found.' };
    const copy = {
        ...source,
        id: uid(),
        name: targetGameId !== undefined ? source.name : `${source.name} (Copy)`,
        locked: false,
        gameId: targetGameId !== undefined ? targetGameId : source.gameId,
    };
    appState.profiles.push(copy);
    await persistState();
    return { success: true, profiles: appState.profiles, newId: copy.id };
});

// =====================================================================
// game library CRUD
// =====================================================================

ipcMain.handle('save-game', async (event, game) => {
    const idx = appState.games.findIndex(g => g.id === game.id);
    if (idx === -1) {
        appState.games.push({ ...defaultGameShape(), ...game, id: game.id || uid() });
    } else {
        appState.games[idx] = { ...appState.games[idx], ...game };
    }
    await persistState();
    return appState.games;
});

ipcMain.handle('add-game', async (event, game) => {
    const newGame = { ...defaultGameShape(), id: uid(), ...game };
    appState.games.push(newGame);
    await persistState();
    return newGame;
});

ipcMain.handle('delete-game', async (event, id) => {
    appState.games = appState.games.filter(g => g.id !== id);
    // tools that belonged to this game fall back to unassigned rather than
    // pointing at a game that no longer exists
    for (const p of appState.profiles) {
        if (p.gameId === id) p.gameId = '';
    }
    await persistState();
    return { success: true, games: appState.games, profiles: appState.profiles };
});

ipcMain.handle('reorder-games', async (event, orderedVisibleIds) => {
    appState.games = applyPartialReorder(appState.games, orderedVisibleIds);
    await persistState();
    return appState.games;
});

ipcMain.handle('reorder-profiles', async (event, orderedVisibleIds) => {
    appState.profiles = applyPartialReorder(appState.profiles, orderedVisibleIds);
    await persistState();
    return appState.profiles;
});

ipcMain.handle('pick-cover-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (canceled || !filePaths.length) return null;
    const filePath = filePaths[0];
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const buffer = await fs.readFile(filePath);
    return `data:image/${mime};base64,${buffer.toString('base64')}`;
});

function normalizeForCompare(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A search hit only counts as a real match if the names actually overlap —
// otherwise a game with no Steam listing at all (e.g. Minecraft: Java &
// Bedrock Edition, Microsoft-exclusive) would silently get a same-franchise
// spin-off's art attached (Steam's search returned "Minecraft Dungeons" as
// its top hit for "Minecraft") instead of correctly reporting no match.
function isConfidentNameMatch(query, candidate) {
    const q = normalizeForCompare(query);
    const c = normalizeForCompare(candidate);
    if (!q || !c) return false;
    if (q === c) return true;
    // a single generic word (e.g. "minecraft") is trivially a substring of
    // an unrelated same-franchise spin-off ("minecraft dungeons") — only an
    // exact match is trustworthy there; containment is only safe once the
    // query is a distinctive enough multi-word phrase to not be a coincidence
    if (q.split(' ').filter(Boolean).length < 2) return false;
    return c.includes(q) || q.includes(c);
}

// Guessed static CDN paths (cdn.akamai.steamstatic.com/steam/apps/<id>/...)
// 404 for a lot of smaller/newer titles that never had full "Steam Grid"
// assets generated — appdetails is the authoritative source and returns a
// real (hash-versioned) header_image URL whenever the store page has one.
async function resolveSteamArtUrl(appId) {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`appdetails request failed (${res.status})`);
    const data = await res.json();
    const entry = data[String(appId)];
    if (!entry || !entry.success || !entry.data) return null;
    return entry.data.header_image || entry.data.capsule_image || null;
}

ipcMain.handle('resolve-steam-art', async (event, appId) => {
    try {
        const url = await resolveSteamArtUrl(appId);
        if (!url) return { success: false, error: `Steam has no store art for app id ${appId}.` };
        return { success: true, url };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Steam's own public store search has no auth requirement and covers almost
// any well-known PC title, Steam release or not — used as a cover-art-only
// lookup for platforms (Ubisoft, Xbox, "Other") with no free art CDN of
// their own. Never affects the game's actual launch method, only which box
// art gets displayed.
ipcMain.handle('find-cover-online', async (event, name) => {
    try {
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&cc=us&l=en`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`search request failed (${res.status})`);
        const data = await res.json();
        const items = data.items || [];
        const match = items.find(item => isConfidentNameMatch(name, item.name));
        if (!match) {
            const closest = items[0] ? ` (closest result was "${items[0].name}", which looked like a different game)` : '';
            return { success: false, error: `no confident Steam match for "${name}"${closest} — try "Choose image" instead.` };
        }
        const imageUrl = await resolveSteamArtUrl(match.id);
        if (!imageUrl) return { success: false, error: `found "${match.name}" on Steam, but it has no store art available.` };
        return { success: true, appId: String(match.id), matchedName: match.name, imageUrl };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// =====================================================================
// archive helpers — extension-routed listing / extraction, generalized
// from the mod-manager archive tooling (zip via adm-zip, 7z via the
// bundled 7za binary, rar via node-unrar-js since 7za can't read rar)
// =====================================================================

async function listExeEntriesInArchive(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip') {
        const zip = new AdmZip(filePath);
        return zip.getEntries()
            .filter(e => !e.isDirectory && isLaunchableFile(e.entryName))
            .map(e => e.entryName);
    }
    if (ext === '.rar') {
        const extractor = await createExtractorFromFile({ filepath: filePath });
        const list = extractor.getFileList();
        return [...list.fileHeaders]
            .filter(h => !h.flags.directory && isLaunchableFile(h.name))
            .map(h => h.name);
    }
    if (ext === '.7z') {
        return new Promise((resolve, reject) => {
            const names = [];
            const stream = Seven.list(filePath, { $bin: pathTo7zip });
            stream.on('data', (d) => { if (d && d.file && isLaunchableFile(d.file)) names.push(d.file); });
            stream.on('end', () => resolve(names));
            stream.on('error', reject);
        });
    }
    return [];
}

// Retries on a locked target file — a self-deleting exe from a previous run
// sometimes leaves the delete pending for a moment, which races a fresh
// extraction and throws EBUSY/EPERM if we don't back off and try again.
async function extractArchiveWithRetry(filePath, destDir, label) {
    const ext = path.extname(filePath).toLowerCase();
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (ext === '.zip') {
                const zip = new AdmZip(filePath);
                zip.extractAllTo(destDir, true);
            } else if (ext === '.rar') {
                await fs.ensureDir(destDir);
                const extractor = await createExtractorFromFile({ filepath: filePath, targetPath: destDir });
                const result = extractor.extract();
                for (const _f of result.files) { /* drain iterator to force extraction */ }
            } else if (ext === '.7z') {
                await new Promise((resolve, reject) => {
                    const stream = Seven.extractFull(filePath, destDir, { $bin: pathTo7zip, recursive: true });
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });
            } else {
                throw new NonRetryableError(`unsupported archive type: ${ext || '(none)'}`);
            }
            return;
        } catch (error) {
            if (error instanceof NonRetryableError) throw error;
            const isLockError = /EBUSY|EPERM|EACCES/i.test(error.message || '');
            if (!isLockError || attempt === maxAttempts) throw error;
            logToConsole(`${label}: file still in use by the previous run, retrying extraction (${attempt}/${maxAttempts})...`, 'info');
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

// =====================================================================
// process tracking
// =====================================================================

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function findRunningProcessInDir(dir, timeoutMs, exePath) {
    const deadline = Date.now() + timeoutMs;
    // exePath narrows the match to the specific file this profile launches —
    // without it, any unrelated process that happens to live under the same
    // folder (a background service, an updater, a helper the tool itself
    // spawns) reads as "still running" and permanently blocks relaunch even
    // after the actual game/tool has fully exited. Checked against both
    // ExecutablePath (plain .exe) and CommandLine (interpreted .bat/.ps1/.vbs
    // etc, where the process's own ExecutablePath is the interpreter, not
    // the script — the script path only shows up as a command-line arg).
    let pathFilter = '';
    if (exePath) {
        const esc = exePath.replace(/'/g, "''");
        pathFilter = ` -and ($_.ExecutablePath -eq '${esc}' -or $_.CommandLine -like '*${esc}*')`;
    }
    const psCommand = `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dir.replace(/'/g, "''")}\\*'${pathFilter} } | Select-Object -First 1 -ExpandProperty Name)`;
    while (Date.now() < deadline) {
        const name = await new Promise((resolve) => {
            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (error, stdout) => {
                resolve(error ? null : (stdout || '').trim() || null);
            });
        });
        if (name) return name;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

// =====================================================================
// elevation strategies
// =====================================================================

function buildLaunchAndActivateScript(exePath, workingDir, useRunAs) {
    const dirEscaped = workingDir.replace(/'/g, "''");
    const verbArg = useRunAs ? ' -Verb RunAs' : '';
    // .ps1 targets can't go through -FilePath directly: Start-Process resolves
    // them via the file's shell association (Notepad's "Edit" verb, not
    // "Run"), so the script never executes. Route them through powershell.exe
    // -File instead, same as double-clicking a .ps1 silently fails to do.
    const isPs1 = /\.ps1$/i.test(exePath);
    const startCommand = isPs1
        ? `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(exePath)} -WorkingDirectory ${psQuote(workingDir)}${verbArg} -PassThru`
        : `$p = Start-Process -FilePath ${psQuote(exePath)} -WorkingDirectory ${psQuote(workingDir)}${verbArg} -PassThru`;
    return [
        startCommand,
        `$shell = New-Object -ComObject WScript.Shell`,
        `Start-Sleep -Milliseconds 1200`,
        `try { $shell.AppActivate($p.Id) | Out-Null } catch {}`,
        `Start-Sleep -Milliseconds 800`,
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dirEscaped}\\*' } | ForEach-Object { try { $shell.AppActivate($_.ProcessId) | Out-Null } catch {} }`,
    ].join('; ');
}

// "prompt": shows a real UAC dialog every launch (or launches un-elevated if
// elevateMode is 'none'). Needed whenever the exe path can change between
// launches (archive re-extraction, self-renaming tools) since a scheduled
// task would need re-registering — and re-registering also needs a UAC
// prompt, so there's no silent path available there anyway.
function launchPrompt(exePath, workingDir, elevateMode) {
    return new Promise((resolve, reject) => {
        const script = buildLaunchAndActivateScript(exePath, workingDir, elevateMode === 'prompt');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error, stdout, stderr) => {
            if (error) { reject(new Error(`launch failed (${(stderr || error.message).trim()})`)); return; }
            resolve();
        });
    });
}

function elevatedTaskName(profileId) {
    return `AllPurposeLauncher_${profileId.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

function getRegisteredTaskArgument(taskName) {
    return new Promise((resolve) => {
        const psCommand = [
            `$t = Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue`,
            `if ($t) { $a = $t.Actions | Select-Object -First 1; Write-Output "$($a.Execute)|$($a.Arguments)" }`,
        ].join('; ');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], (error, stdout) => {
            const line = (error ? '' : (stdout || '')).trim();
            if (!line.includes('|')) { resolve(null); return; }
            const sep = line.indexOf('|');
            resolve({ execute: line.slice(0, sep), argument: line.slice(sep + 1) });
        });
    });
}

function runElevatedPowerShell(script) {
    return new Promise((resolve, reject) => {
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const outerCommand = [
            `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',${psQuote(encoded)}`,
            `if ($p.ExitCode -ne 0) { throw "elevated script exited with code $($p.ExitCode)" }`,
        ].join('; ');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outerCommand], (error, stdout, stderr) => {
            if (error) { reject(new Error(`elevation was cancelled or failed (${(stderr || error.message).trim()})`)); return; }
            resolve();
        });
    });
}

// "silent": registers a Highest-run-level Scheduled Task once (one real UAC
// accept), then every subsequent launch runs the already-registered task —
// Windows treats that as standing consent, so no popup after the first time.
async function ensureElevatedTaskRegistered(taskName, launchArgument, label) {
    const existing = await getRegisteredTaskArgument(taskName);
    if (existing && /powershell(\.exe)?$/i.test(existing.execute) && existing.argument === launchArgument) return;
    logToConsole(`${label}: one-time setup — accept the UAC prompt to enable silent launching for this tool.`, 'info');
    const registerScript = [
        `try {`,
        `  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${psQuote(launchArgument)}`,
        `  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -RunLevel Highest -LogonType Interactive`,
        `  Register-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action -Principal $principal -Force | Out-Null`,
        `} catch { exit 1 }`,
        `exit 0`,
    ].join('\n');
    await runElevatedPowerShell(registerScript);
}

async function launchSilent(exePath, workingDir, profileId, label) {
    const taskName = elevatedTaskName(profileId);
    const script = buildLaunchAndActivateScript(exePath, workingDir, false);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const launchArgument = `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
    await ensureElevatedTaskRegistered(taskName, launchArgument, label);
    await new Promise((resolve, reject) => {
        execFile('schtasks.exe', ['/Run', '/TN', taskName], (error, stdout, stderr) => {
            if (error) { reject(new Error(`failed to start ${label} via scheduled task: ${(stderr || error.message).trim()}`)); return; }
            resolve();
        });
    });
}

async function launchProcess(exePath, workingDir, elevateMode, profileId, label) {
    if (elevateMode === 'silent') return launchSilent(exePath, workingDir, profileId, label);
    return launchPrompt(exePath, workingDir, elevateMode);
}

// =====================================================================
// unified launch engine
// =====================================================================

class NonRetryableError extends Error {}
class CancelledError extends NonRetryableError {}

// folder/workingDir path -> the name the running process was last confirmed
// under, so a second click can't stack a duplicate instance on top of one
// that's still alive (these tools often share a session/license token —
// two live copies can get both kicked).
const activeRuns = new Map();
const cancelRequested = new Set();

function consumeCancelFlag(id) {
    if (id && cancelRequested.has(id)) { cancelRequested.delete(id); return true; }
    return false;
}

async function sleepOrCancel(ms, id) {
    const step = 250;
    let waited = 0;
    while (waited < ms) {
        if (id && cancelRequested.has(id)) return true;
        const chunk = Math.min(step, ms - waited);
        await new Promise(r => setTimeout(r, chunk));
        waited += chunk;
    }
    return !!(id && cancelRequested.has(id));
}

function getWorkingDir(profile) {
    if (profile.method === 'folder') return profile.targetPath;
    return path.dirname(profile.targetPath || '.');
}

function sendProgress(profileId, attempt, status, extra) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launch-progress', { profileId, attempt, status, ...extra });
    }
}

function backgroundWatch(profileId, workingDir, ticks) {
    (async () => {
        for (let i = 0; i < ticks; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const name = await findRunningProcessInDir(workingDir, 1);
            if (name) activeRuns.set(profileId, name); else { activeRuns.delete(profileId); break; }
        }
    })();
}

// cheap, side-effect-free lookup of the path resolveExePath() will launch
// (skips the archive branch's actual extraction) — used to narrow the
// "already running" check to the specific file instead of the whole folder.
async function resolveExpectedExePath(profile, workingDir) {
    if (profile.method === 'direct') return profile.targetPath;
    if (profile.method === 'folder') {
        const entries = await fs.readdir(profile.targetPath);
        const exeName = entries.find(f => isLaunchableFile(f));
        return exeName ? path.join(profile.targetPath, exeName) : null;
    }
    const entryNames = await listExeEntriesInArchive(profile.targetPath);
    return entryNames[0] ? path.join(workingDir, entryNames[0]) : null;
}

async function resolveExePath(profile, workingDir) {
    if (profile.method === 'direct') {
        if (!isLaunchableFile(profile.targetPath)) {
            throw new NonRetryableError(`the direct path must point straight at a runnable file (${LAUNCHABLE_EXTENSIONS.join(', ')}).`);
        }
        return profile.targetPath;
    }
    if (profile.method === 'folder') {
        const entries = await fs.readdir(profile.targetPath);
        const exeName = entries.find(f => isLaunchableFile(f));
        if (!exeName) throw new NonRetryableError(`no runnable file found inside the folder: ${profile.targetPath}`);
        return path.join(profile.targetPath, exeName);
    }
    // archive: re-extract fresh every launch into the archive's own folder —
    // companion auth/config files often sit next to the archive, outside it,
    // and the file reads those on startup, so an isolated temp extraction
    // would strip it away from that data.
    const entryNames = await listExeEntriesInArchive(profile.targetPath);
    if (entryNames.length === 0) throw new NonRetryableError(`no runnable file found inside the archive.`);
    const entryName = entryNames[0];
    await extractArchiveWithRetry(profile.targetPath, workingDir, profile.name);
    const exePath = path.join(workingDir, entryName);
    if (!(await fs.pathExists(exePath))) {
        throw new Error(`extraction reported success but ${exePath} is missing — antivirus may have quarantined it. check your AV's quarantine/threat history.`);
    }
    return exePath;
}

async function attemptLaunch(profile, attempt) {
    await appendDebugLog(`=== ${profile.name} launch attempt started (try ${attempt}) ===`);
    if (!profile.targetPath) throw new NonRetryableError(`set a path for ${profile.name} in settings first.`);
    if (!(await fs.pathExists(profile.targetPath))) throw new NonRetryableError(`path not found: ${profile.targetPath}`);

    const workingDir = getWorkingDir(profile);

    const trackedRunningAs = activeRuns.get(profile.id);
    if (trackedRunningAs) {
        const expectedExePath = await resolveExpectedExePath(profile, workingDir);
        const stillAlive = await findRunningProcessInDir(workingDir, 1, expectedExePath);
        if (stillAlive) {
            throw new NonRetryableError(`${profile.name} is already running (as "${stillAlive}"). Launching a second copy risks conflicting with it over the same license/session and getting both kicked. If you don't see its window, check behind this one or Alt-Tab.`);
        }
        activeRuns.delete(profile.id);
    }

    const exePath = await resolveExePath(profile, workingDir);
    await appendDebugLog(`launching ${exePath} (elevate=${profile.elevate})`);
    logToConsole(`launching ${profile.name}: ${exePath}`, 'info');
    await launchProcess(exePath, workingDir, profile.elevate, profile.id, profile.name);
    await appendDebugLog(`launchProcess() returned without error`);

    if (!profile.retry) {
        backgroundWatch(profile.id, workingDir, 24);
        const confirmation = `${profile.name} launched.`;
        logToConsole(confirmation, 'success');
        return { exePath, confirmation };
    }

    // retry-enabled tools get a full aliveness check: startup confirmation,
    // then a "danger window" watch — observed failure pattern for these is
    // dying ~7-8s in from a server-side license/auth check timing out, while
    // healthy launches sail straight through, so it's worth watching before
    // declaring success rather than trusting the launch command not erroring.
    let runningAs = null;
    for (let i = 0; i < 6; i++) {
        const name = await findRunningProcessInDir(workingDir, 1);
        if (name) { runningAs = name; break; }
        await new Promise(r => setTimeout(r, 500));
    }
    if (!runningAs) {
        throw new Error(`${profile.name} was launched but nothing is running from "${workingDir}" a few seconds later. This usually means the UAC prompt was denied or never appeared, antivirus/SmartScreen blocked it, or it requires the game to already be running.`);
    }

    const dangerWindowChecks = 17; // ~14s at 800ms apart
    for (let i = 1; i <= dangerWindowChecks; i++) {
        if (consumeCancelFlag(profile.id)) throw new CancelledError(`${profile.name} launch cancelled.`);
        await new Promise(r => setTimeout(r, 800));
        const name = await findRunningProcessInDir(workingDir, 1);
        if (!name) {
            throw new Error(`${profile.name} started but died about ${(i * 0.8).toFixed(0)}s later. This pattern usually means an intermittent server-side check timed out — not a problem with the launch itself.`);
        }
        runningAs = name;
    }
    activeRuns.set(profile.id, runningAs);
    backgroundWatch(profile.id, workingDir, 24);

    const confirmation = `${profile.name} confirmed running as "${runningAs}" — its window should now be in front. If you don't see it, check behind this window or Alt-Tab.`;
    logToConsole(confirmation, 'success');
    return { exePath, confirmation };
}

async function launchWithRetryLoop(profile) {
    cancelRequested.delete(profile.id);
    for (let attempt = 1; ; attempt++) {
        if (consumeCancelFlag(profile.id)) throw new CancelledError(`${profile.name} launch cancelled.`);
        sendProgress(profile.id, attempt, 'trying');
        try {
            const result = await attemptLaunch(profile, attempt);
            sendProgress(profile.id, attempt, 'succeeded');
            return result;
        } catch (error) {
            await appendDebugLog(`attempt ${attempt} failed: ${error.message}`);
            if (error instanceof NonRetryableError) throw error;
            const delayMs = Math.min(2000 * attempt, 20000);
            logToConsole(`${profile.name} attempt ${attempt} didn't stick (${error.message}). Retrying in ${Math.round(delayMs / 1000)}s...`, 'warn');
            sendProgress(profile.id, attempt, 'waiting', { delayMs, nextAttempt: attempt + 1 });
            const cancelledDuringWait = await sleepOrCancel(delayMs, profile.id);
            if (cancelledDuringWait) { consumeCancelFlag(profile.id); throw new CancelledError(`${profile.name} launch cancelled.`); }
        }
    }
}

ipcMain.handle('launch-profile', async (event, profileId) => {
    const profile = getProfile(profileId);
    if (!profile) return { success: false, error: 'profile not found.' };
    try {
        const result = profile.retry ? await launchWithRetryLoop(profile) : await attemptLaunch(profile, 1);
        return { success: true, message: result.confirmation };
    } catch (error) {
        logToConsole(`error launching ${profile.name}: ${error.message}`, error instanceof CancelledError ? 'warn' : 'error');
        return { success: false, error: error.message, cancelled: error instanceof CancelledError };
    }
});

ipcMain.handle('cancel-launch', async (event, profileId) => {
    cancelRequested.add(profileId);
    return { success: true };
});

// =====================================================================
// game auto-detection (Steam / Epic Games / Xbox) + linked game launch
// =====================================================================

let gameScanCache = null;

ipcMain.handle('scan-games', async () => {
    logToConsole('scanning Steam / Epic Games / Xbox libraries for installed games...', 'info');
    try {
        gameScanCache = await gameDetect.scanInstalledGames();
        logToConsole(`found ${gameScanCache.length} installed game(s).`, 'success');
        return { success: true, games: gameScanCache };
    } catch (error) {
        logToConsole(`game scan failed: ${error.message}`, 'error');
        return { success: false, error: error.message, games: [] };
    }
});

ipcMain.handle('launch-game', async (event, gameId) => {
    const game = getGame(gameId);
    if (!game) return { success: false, error: 'game not found in library.' };
    try {
        // Each platform's own protocol is preferred whenever its id is known —
        // it finds/launches the correct exe itself (initializing anti-cheat,
        // Store app-identity, etc. the way a raw exe launch often doesn't).
        // exePath (whether typed in or auto-detected during a scan) is only a
        // fallback for when that id is missing — it must NOT silently override
        // a working protocol launch just because it happens to be filled in.
        if (game.platform === 'Steam' && game.steamAppId) {
            logToConsole(`launching game via steam://rungameid/${game.steamAppId}`, 'info');
            await shell.openExternal(`steam://rungameid/${game.steamAppId}`);
            return { success: true };
        }
        if (game.platform === 'Epic Games' && game.epicAppName) {
            const url = `com.epicgames.launcher://apps/${encodeURIComponent(game.epicAppName)}?action=launch&silent=true`;
            logToConsole(`launching game via ${url}`, 'info');
            await shell.openExternal(url);
            return { success: true };
        }
        if (game.platform === 'Ubisoft' && game.ubisoftId) {
            logToConsole(`launching game via uplay://launch/${game.ubisoftId}/0`, 'info');
            await shell.openExternal(`uplay://launch/${game.ubisoftId}/0`);
            return { success: true };
        }
        if (game.platform === 'Roblox') {
            // re-resolved fresh every launch rather than a stored path — the
            // client exe lives in a version-stamped folder that changes on
            // every auto-update (see gameDetect.findRobloxPlayerExe)
            const exePath = gameDetect.findRobloxPlayerExe();
            if (!exePath) throw new Error('Roblox does not appear to be installed (no RobloxPlayerBeta.exe found under %LOCALAPPDATA%\\Roblox\\Versions).');
            logToConsole(`launching Roblox: ${exePath}`, 'info');
            const openError = await shell.openPath(exePath);
            if (openError) throw new Error(`failed to launch: ${openError}`);
            return { success: true };
        }
        if (game.platform === 'Microsoft' && game.xboxLaunchId) {
            logToConsole(`launching game via shell:AppsFolder\\${game.xboxLaunchId}`, 'info');
            await new Promise((resolve, reject) => {
                execFile('explorer.exe', [`shell:AppsFolder\\${game.xboxLaunchId}`], (error) => {
                    // explorer.exe returns a nonzero/odd exit code on success too, so
                    // only genuine spawn failures (ENOENT etc.) are treated as errors
                    if (error && error.code === 'ENOENT') { reject(error); return; }
                    resolve();
                });
            });
            return { success: true };
        }
        if (game.exePath) {
            if (!(await fs.pathExists(game.exePath))) throw new Error(`game executable not found: ${game.exePath}`);
            logToConsole(`launching game (direct exe): ${game.exePath}`, 'info');
            const openError = await shell.openPath(game.exePath);
            if (openError) throw new Error(`failed to launch: ${openError}`);
            return { success: true };
        }
        throw new Error(`no launch method available for ${game.name} — scan for games, or set a game executable path manually in Settings.`);
    } catch (error) {
        logToConsole(`error launching game: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
});
