const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (data) => ipcRenderer.invoke('dialog:saveFile', data),
  onTriggerSaveFile: (callback) => ipcRenderer.on('trigger-save-file', callback),
  onBeforeClose: (callback) => ipcRenderer.on('before-close', callback),
  sendIsDirty: (id, isDirty) => ipcRenderer.send(`is-dirty-${id}`, isDirty),
  fileSaved: (id) => ipcRenderer.send(`file-saved-${id}`),
  updateTitle: (data) => ipcRenderer.send('update-title', data),
  openSpecificFile: (filePath) => ipcRenderer.invoke('open-specific-file', filePath),
  onLoadFile: (callback) => ipcRenderer.on('load-file', (event, data) => callback(data)),
});