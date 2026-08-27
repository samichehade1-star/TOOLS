// main.js — electron main process: window chrome, settings, engine process, IPC

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

app.setName('Diddler');

// =====================================================================
// elevation — FiddlerCore (proxy registration + cert trust) needs an
// administrator token. The packaged build gets that for free: electron-builder
// bakes a requireAdministrator manifest into Diddler.exe (see package.json
// build.win.requestedExecutionLevel), so Windows UAC-prompts on launch and
// every child process spawned after that inherits the elevated token.
// `npm start` in dev mode runs the plain node_modules/electron.exe binary
// though, which carries no such manifest — so without this check the engine
// spawns unelevated and FiddlerCore's static init throws. Self-relaunching
// elevated here closes that gap so dev mode behaves the same as the
// installed app instead of silently failing.
function isElevatedOnWindows() {
    try { execSync('net session', { stdio: 'ignore' }); return true; }
    catch { return false; }
}

function relaunchElevatedAndQuit() {
    const exePath = process.execPath;
    const appPath = app.getAppPath();
    spawn('powershell.exe', [
        '-NoProfile', '-WindowStyle', 'hidden', '-Command',
        `Start-Process -FilePath '${exePath}' -ArgumentList '${appPath}' -Verb RunAs`,
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
}

const needsDevElevation = process.platform === 'win32' && !app.isPackaged && !isElevatedOnWindows();
if (needsDevElevation) relaunchElevatedAndQuit();

// --- paths ---
const appDataPath = app.getPath('userData');
const settingsFilePath = path.join(appDataPath, 'settings.json');

let mainWindow;
let engineProc = null;
let engineRl = null;

// =====================================================================
// settings (theme + window size), persisted the same write-then-rename
// way as the launcher — avoids a half-written file if the app is killed
// mid-save.
// =====================================================================
function defaultTheme() {
    return { accent: '#9b4bff', accent2: '#e07820' };
}

let appState = {
    theme: defaultTheme(),
    windowBounds: { width: 900, height: 680 },
};

async function loadState() {
    try {
        const raw = await fs.promises.readFile(settingsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        appState = {
            theme: { ...defaultTheme(), ...(parsed.theme || {}) },
            windowBounds: parsed.windowBounds || appState.windowBounds,
        };
    } catch { /* first run or corrupt file — keep defaults */ }
}

async function persistState() {
    const json = JSON.stringify(appState, null, 2);
    const tmpFilePath = settingsFilePath + '.tmp';
    try {
        await fs.promises.mkdir(appDataPath, { recursive: true });
        await fs.promises.writeFile(tmpFilePath, json, 'utf8');
        await fs.promises.rename(tmpFilePath, settingsFilePath);
    } catch { /* best effort */ }
}

// =====================================================================
// window chrome
// =====================================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: appState.windowBounds.width,
        height: appState.windowBounds.height,
        minWidth: 700,
        minHeight: 560,
        frame: false,
        backgroundColor: '#0d0d14',
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
        },
    });

    mainWindow.loadFile('index.html');

    let resizeTimer = null;
    mainWindow.on('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(async () => {
            if (mainWindow.isDestroyed()) return;
            const [width, height] = mainWindow.getSize();
            appState.windowBounds = { width, height };
            await persistState();
        }, 500);
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.on('maximize-window', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow && mainWindow.close());

// =====================================================================
// theme / state
// =====================================================================
ipcMain.handle('get-state', () => appState);

ipcMain.handle('save-theme', async (event, theme) => {
    appState.theme = { ...appState.theme, ...theme };
    await persistState();
    return appState.theme;
});

ipcMain.handle('read-clipboard', () => clipboard.readText().trim());

// =====================================================================
// auto-update (electron-updater, GitHub releases)
// =====================================================================
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function sendUpdateStatus(status, extra = {}) {
    sendToRenderer('update-status', { status, ...extra });
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

// =====================================================================
// engine process — spawned once, talked to over stdio for the app's
// whole lifetime. Newline-delimited JSON both ways; see engine/Program.cs.
// =====================================================================
function engineExePath() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'engine', 'DiddlerEngine.exe');
    return path.join(__dirname, 'engine', 'bin', 'Release', 'net8.0-windows', 'DiddlerEngine.exe');
}

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function startEngine() {
    const exePath = engineExePath();
    if (!fs.existsSync(exePath)) {
        sendToRenderer('engine-status', { state: 'error', message: 'Engine executable not found — run "npm run build-engine" first.' });
        return;
    }

    engineProc = spawn(exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    engineRl = readline.createInterface({ input: engineProc.stdout });
    engineRl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        switch (msg.type) {
            case 'status':   sendToRenderer('engine-status', msg); break;
            case 'log':      sendToRenderer('engine-log', msg); break;
            case 'captured': sendToRenderer('engine-captured', msg); break;
            case 'result':   sendToRenderer('engine-result', msg); break;
        }
    });

    let stderrBuf = '';
    engineProc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    engineProc.on('exit', (code) => {
        engineProc = null;
        sendToRenderer('engine-status', {
            state: 'error',
            message: code === 0 ? 'Engine stopped.' : `Engine exited unexpectedly (code ${code}).${stderrBuf ? ' ' + stderrBuf.slice(0, 200) : ''}`,
        });
    });

    engineProc.on('error', (err) => {
        sendToRenderer('engine-status', { state: 'error', message: `Failed to launch engine: ${err.message}` });
    });
}

function writeToEngine(obj) {
    if (!engineProc || engineProc.stdin.destroyed) return false;
    engineProc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
}

// Graceful, race-free shutdown. The original WinForms app called
// CaptureEngine.Stop() synchronously on its own UI thread right before the
// process exited naturally, so FiddlerApplication.Shutdown() — which
// unregisters DBD's traffic from the Windows system proxy — always finished
// before the process was gone. Across a stdio-piped child process that's no
// longer automatic: writing the shutdown command and immediately
// force-killing the child races Shutdown() actually completing. Losing that
// race leaves Windows pointed at a dead proxy port, breaking every other
// app's internet connection until something resets the system proxy
// manually. So instead: ask nicely, then WAIT for the child to exit on its
// own (Program.cs's shutdown handler calls Stop() then Environment.Exit(0)
// synchronously), and only force-kill as a last resort if it hangs.
function stopEngineGracefully(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!engineProc) { resolve(); return; }
        const proc = engineProc;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        proc.once('exit', finish);
        const wrote = writeToEngine({ cmd: 'shutdown' });
        if (!wrote) { finish(); return; }
        setTimeout(() => {
            if (settled) return;
            try { proc.kill(); } catch {}
            finish();
        }, timeoutMs);
    });
}

ipcMain.handle('send-request', (event, { kind, playerId }) => {
    const ok = writeToEngine({ cmd: 'send', kind, playerId });
    if (!ok) sendToRenderer('engine-result', { type: 'result', kind, ok: false, status: 'Engine is not running' });
});

// =====================================================================
// session auto-shutdown — the whole point of Diddler is a proxy quietly
// MITM'ing DBD's traffic; leaving that running unattended indefinitely is
// the thing to avoid, so the app closes itself after SESSION_MS unless the
// user actively confirms they're still using it. The last WARNING_MS of
// that window shows a countdown modal and pulls the window to the front —
// above the game too, since that's presumably what's actually focused.
// =====================================================================
const SESSION_MS = 2 * 60 * 1000;
const WARNING_MS = 30 * 1000;

let warnTimeout = null;
let countdownInterval = null;

function clearSessionTimers() {
    clearTimeout(warnTimeout);
    clearInterval(countdownInterval);
    warnTimeout = null;
    countdownInterval = null;
}

function startSessionTimer() {
    clearSessionTimers();
    warnTimeout = setTimeout(beginWarning, SESSION_MS - WARNING_MS);
}

function beginWarning() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    mainWindow.flashFrame(true);

    let remaining = WARNING_MS / 1000;
    sendToRenderer('session-warning', { remaining });

    countdownInterval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearSessionTimers();
            closeApp();
            return;
        }
        sendToRenderer('session-warning', { remaining });
    }, 1000);
}

ipcMain.on('session-still-here', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    sendToRenderer('session-warning-hide');
    startSessionTimer();
});

function closeApp() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    app.quit();
}

// =====================================================================
// lifecycle
// =====================================================================
if (!needsDevElevation) {
    app.whenReady().then(async () => {
        await loadState();
        createWindow();
        startEngine();
        startSessionTimer();
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Every quit path (window closed, session timeout, Cmd/Alt+F4, OS shutdown)
// funnels through here. preventDefault + the isQuitting guard turns Electron's
// normally-fire-and-forget quit into one that waits for the engine to
// actually confirm it tore down the system proxy before letting the process
// die — see stopEngineGracefully() above for why that wait matters.
let isQuitting = false;
app.on('before-quit', (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    clearSessionTimers();
    stopEngineGracefully().then(() => app.quit());
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
