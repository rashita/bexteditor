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
  openLink: (linkText,currentFilePath) => ipcRenderer.send("open-link", linkText,currentFilePath),
  shiftFile: (filePath,offsetDays) => ipcRenderer.send('shift-file', filePath,offsetDays),
  levelFile: (filePath,isUp) => ipcRenderer.send('level-file', filePath,isUp),
  readMarkdownFile: (filename) => ipcRenderer.invoke("read-markdown-file", filename),
  openFile: (filePath) => ipcRenderer.send('request-open-file', filePath),
  onFileUpdated: (callback) => ipcRenderer.on('file-updated', (event, data) => callback(data)),
  onChangeFont: (callback) => ipcRenderer.on('change-font', (event, font) => callback(font)),
  loadMdFile: (key) => ipcRenderer.invoke('load-md-file', key)
});

ipcRenderer.on('set-background', (_, imgUrl) => {
  const imgElement = document.getElementById('bgimg');
  if (imgElement) {
    imgElement.src = `file://${imgUrl}`;
  }
});