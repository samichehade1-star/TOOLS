const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // resolves the real filesystem path of a dropped File object — under
  // contextIsolation, File.path is no longer reliably populated, this is
  // the modern replacement (must be called from the preload/main-world
  // bridge, not directly in renderer code)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),

  // dialogs
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  openFileDialog: (filters) => ipcRenderer.invoke('open-file-dialog', filters),
  openDiscordInvite: () => ipcRenderer.invoke('open-discord-invite'),

  // settings
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  loadSettings: () => ipcRenderer.invoke('load-settings'),

  // trainer / spoofer: extract from a user-configured zip and launch fresh each time
  launchTrainer: () => ipcRenderer.invoke('launch-trainer'),
  launchSpoofer: () => ipcRenderer.invoke('launch-spoofer'),
  cancelToolLaunch: (label) => ipcRenderer.invoke('cancel-tool-launch', label),
  // live progress while launch-trainer/launch-spoofer retries in the background
  onToolLaunchProgress: (callback) => ipcRenderer.on('tool-launch-progress', (event, data) => callback(data)),

  // launch the game itself on a chosen platform (Steam/Epic Games/Microsoft)
  launchGame: (platformLabel) => ipcRenderer.invoke('launch-game', platformLabel),


  // mod management
  getInstalledMods: () => ipcRenderer.invoke('get-installed-mods'),
  getAvailableMods: () => ipcRenderer.invoke('get-available-mods'),
  installMod: (modName, modPath) => ipcRenderer.invoke('install-mod', modName, modPath),
  uninstallMod: (modName) => ipcRenderer.invoke('uninstall-mod', modName),
  uninstallAllMods: () => ipcRenderer.invoke('uninstall-all-mods'),
  deleteMod: (modName) => ipcRenderer.invoke('delete-mod', modName),
  archiveMod: (modName) => ipcRenderer.invoke('archive-mod', modName),
  restoreArchivedMod: (modName) => ipcRenderer.invoke('restore-archived-mod', modName),
  getArchivedMods: () => ipcRenderer.invoke('get-archived-mods'),
  deleteArchivedMod: (modName) => ipcRenderer.invoke('delete-archived-mod', modName),
  getModConflicts: () => ipcRenderer.invoke('get-mod-conflicts'),

  // multi-platform game install detection & deploy targets
  detectGameInstalls: () => ipcRenderer.invoke('detect-game-installs'),
  addDeployTarget: (platform, pakFolderPath) => ipcRenderer.invoke('add-deploy-target', platform, pakFolderPath),
  removeDeployTarget: (targetId) => ipcRenderer.invoke('remove-deploy-target', targetId),
  getDeployTargets: () => ipcRenderer.invoke('get-deploy-targets'),

  // downloads tab: find real mod archives, rename in place, move into library
  getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
  setDownloadsPath: (folderPath) => ipcRenderer.invoke('set-downloads-path', folderPath),
  scanDownloadsForMods: () => ipcRenderer.invoke('scan-downloads-for-mods'),
  renameDownloadFile: (oldPath, newBaseName) => ipcRenderer.invoke('rename-download-file', oldPath, newBaseName),
  moveDownloadToLibrary: (filePath) => ipcRenderer.invoke('move-download-to-library', filePath),
  importDroppedModFile: (filePath) => ipcRenderer.invoke('import-dropped-mod-file', filePath),
  createVariantMods: (filePath, selectedVariantFolders) => ipcRenderer.invoke('create-variant-mods', filePath, selectedVariantFolders),
  onDownloadsFolderChanged: (callback) => ipcRenderer.on('downloads-folder-changed', callback),

  // metadata
  saveModMetadata: (modName, metadata) => ipcRenderer.invoke('save-mod-metadata', modName, metadata),
  readModMetadata: (modName) => ipcRenderer.invoke('read-mod-metadata', modName),

  // conversor
  convertToMmpackage: (modName, filePaths) => ipcRenderer.invoke('convert-to-mmpackage', modName, filePaths),

  // mod profiles (save/load named sets of which mods are toggled on)
  saveModProfile: (profileName) => ipcRenderer.invoke('save-mod-profile', profileName),
  loadModProfile: (profileName) => ipcRenderer.invoke('load-mod-profile', profileName),
  listModProfiles: () => ipcRenderer.invoke('list-mod-profiles'),
  deleteModProfile: (profileName) => ipcRenderer.invoke('delete-mod-profile', profileName),

  // console logging from main process
  onLogMessage: (callback) => ipcRenderer.on('log-message', (event, message) => callback(message)),

  // live mods folder watcher
  onModsFolderChanged: (callback) => ipcRenderer.on('mods-folder-changed', callback),

  // signal that renderer is ready
  rendererReady: () => ipcRenderer.send('renderer-ready'),

  // auto-updates
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
});
