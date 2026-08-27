const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.send('minimize-window'),
    maximize: () => ipcRenderer.send('maximize-window'),
    close: () => ipcRenderer.send('close-window'),

    getState: () => ipcRenderer.invoke('get-state'),
    saveTheme: (theme) => ipcRenderer.invoke('save-theme', theme),
    readClipboard: () => ipcRenderer.invoke('read-clipboard'),

    sendRequest: (kind, playerId) => ipcRenderer.invoke('send-request', { kind, playerId }),

    onEngineStatus: (cb) => ipcRenderer.on('engine-status', (event, payload) => cb(payload)),
    onEngineLog: (cb) => ipcRenderer.on('engine-log', (event, payload) => cb(payload)),
    onEngineCaptured: (cb) => ipcRenderer.on('engine-captured', (event, payload) => cb(payload)),
    onEngineResult: (cb) => ipcRenderer.on('engine-result', (event, payload) => cb(payload)),

    sessionStillHere: () => ipcRenderer.send('session-still-here'),
    onSessionWarning: (cb) => ipcRenderer.on('session-warning', (event, payload) => cb(payload)),
    onSessionWarningHide: (cb) => ipcRenderer.on('session-warning-hide', () => cb()),

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    onUpdateStatus: (cb) => ipcRenderer.on('update-status', (event, payload) => cb(payload)),
});
