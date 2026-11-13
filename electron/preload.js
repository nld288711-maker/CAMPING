const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('campingApp', {
  isElectron: true,
  getVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateState: () => ipcRenderer.invoke('update:get'),
  onUpdate: cb => ipcRenderer.on('update:state', (_e, s) => cb(s)),
  onFlushRequest: cb => ipcRenderer.on('app:flush', () => cb()),
  flushDone: () => ipcRenderer.send('app:flushed'),
  installUpdate: () => ipcRenderer.send('update:install')
});
