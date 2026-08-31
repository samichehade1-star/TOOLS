const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.send('minimize-window'),
    splashFinished: () => ipcRenderer.send('splash-finished'),
    maximize: () => ipcRenderer.send('maximize-window'),
    close: () => ipcRenderer.send('close-window'),
    onFlushBeforeClose: (cb) => ipcRenderer.on('flush-before-close', () => cb()),
    flushComplete: () => ipcRenderer.send('flush-complete'),

    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
    pickCoverImage: () => ipcRenderer.invoke('pick-cover-image'),
    findCoverOnline: (name) => ipcRenderer.invoke('find-cover-online', name),
    resolveSteamArt: (appId) => ipcRenderer.invoke('resolve-steam-art', appId),

    getState: () => ipcRenderer.invoke('get-state'),
    saveTheme: (theme) => ipcRenderer.invoke('save-theme', theme),
    saveProfile: (profile) => ipcRenderer.invoke('save-profile', profile),
    addProfile: (profile) => ipcRenderer.invoke('add-profile', profile),
    duplicateProfile: (id, targetGameId) => ipcRenderer.invoke('duplicate-profile', id, targetGameId),
    deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
    reorderProfiles: (ids) => ipcRenderer.invoke('reorder-profiles', ids),

    saveGame: (game) => ipcRenderer.invoke('save-game', game),
    addGame: (game) => ipcRenderer.invoke('add-game', game),
    deleteGame: (id) => ipcRenderer.invoke('delete-game', id),
    reorderGames: (ids) => ipcRenderer.invoke('reorder-games', ids),

    launchProfile: (id) => ipcRenderer.invoke('launch-profile', id),
    cancelLaunch: (id) => ipcRenderer.invoke('cancel-launch', id),
    forceClearActiveRun: (id) => ipcRenderer.invoke('force-clear-active-run', id),
    launchGame: (gameId) => ipcRenderer.invoke('launch-game', gameId),
    scanGames: () => ipcRenderer.invoke('scan-games'),

    onLog: (cb) => ipcRenderer.on('log-message', (event, payload) => cb(payload)),
    onLaunchProgress: (cb) => ipcRenderer.on('launch-progress', (event, payload) => cb(payload)),

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    onUpdateStatus: (cb) => ipcRenderer.on('update-status', (event, payload) => cb(payload)),
});
