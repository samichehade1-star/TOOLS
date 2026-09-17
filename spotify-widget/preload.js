const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setClientId: (id) => ipcRenderer.invoke('config:setClientId', id),
  startAuth: () => ipcRenderer.invoke('auth:start'),
  resetAuth: () => ipcRenderer.invoke('auth:reset'),
  getState: () => ipcRenderer.invoke('spotify:getState'),
  playPause: (isPlaying) => ipcRenderer.invoke('spotify:playPause', isPlaying),
  next: () => ipcRenderer.invoke('spotify:next'),
  previous: () => ipcRenderer.invoke('spotify:previous'),
  setVolume: (percent) => ipcRenderer.invoke('spotify:setVolume', percent),
  getLiked: () => ipcRenderer.invoke('spotify:getLiked'),
  getPlaylists: () => ipcRenderer.invoke('spotify:getPlaylists'),
  getQueue: () => ipcRenderer.invoke('spotify:getQueue'),
  getHot: () => ipcRenderer.invoke('spotify:getHot'),
  playGenre: (genre) => ipcRenderer.invoke('spotify:playGenre', genre),
  playContext: (uri) => ipcRenderer.invoke('spotify:playContext', uri),
  playTrack: (uri) => ipcRenderer.invoke('spotify:playTrack', uri),
  openSpotify: () => ipcRenderer.invoke('app:openSpotify'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  resizeWindow: (width, height) => ipcRenderer.invoke('window:resize', { width, height }),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onForceSetup: (cb) => ipcRenderer.on('force-setup', cb)
});
