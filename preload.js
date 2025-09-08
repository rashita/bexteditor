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
  // 内部リンクを開く関数
  openLink: (linkText, currentFilePath) => {
    return new Promise((resolve, reject) => {
      // メインプロセスから完了通知が来たら resolve
      ipcRenderer.once("open-link-done", () => resolve(true));
      // メインプロセスにリンクを送信
      ipcRenderer.send("open-link", linkText, currentFilePath);
      // エラー通知を使いたい場合は reject を追加できる
      // ipcRenderer.once("open-link-error", (event, err) => reject(err));
    });
  },
  shiftFile: (filePath,offsetDays) => ipcRenderer.send('shift-file', filePath,offsetDays),
  insertFile: (filePath,offsetDays) => ipcRenderer.send('insert-file', filePath,offsetDays),
  levelFile: (filePath,isUp) => ipcRenderer.send('level-file', filePath,isUp),
  readMarkdownFile: (filename) => ipcRenderer.invoke("read-markdown-file", filename),
  openFile: (filePath,fullPath) => ipcRenderer.send('request-open-file', filePath,fullPath),
  onFileUpdated: (callback) => ipcRenderer.on('file-updated', (event, data) => callback(data)),
  onChangeFont: (callback) => ipcRenderer.on('change-font', (event, font) => callback(font)),
  loadMdFile: (key) => ipcRenderer.invoke('load-md-file', key),
  onRequestSelectedText: (callback) => ipcRenderer.on('request-selected-text', callback),
  sendSelectedText: (text) => ipcRenderer.send('selected-text', text),
  onInitText: (callback) => ipcRenderer.on('init-text', (event, text) => callback(text)),
  onToggleTimer: (callback) => ipcRenderer.on('toggle-timer', callback)
});

ipcRenderer.on('set-background', (_, imgUrl) => {
  const imgElement = document.getElementById('bgimg');
  if (imgElement) {
    imgElement.src = `file://${imgUrl}`;
  }
});