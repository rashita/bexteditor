const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getShowLineNumbers: () => ipcRenderer.invoke('get-show-line-numbers'),
  onShowLineNumbersChanged: (callback) =>
    ipcRenderer.on('show-line-numbers-changed', (_event, visible) => callback(visible)),
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
  // Workspace用
  onGetEditorState: (callback) =>
    ipcRenderer.on('get-editor-state', (_e, data) => callback(data)),
  sendEditorStateReply: (winId, state) =>
    ipcRenderer.send(`editor-state-reply-${winId}`, state),
  getRestoreState: (fullPath) =>
    ipcRenderer.invoke('workspace:get-restore-state', fullPath),
  listFiles: (folderPath, sortBy) =>
    ipcRenderer.invoke('workspace:list-files', { folderPath, sortBy }),
  getCurrentWorkspace: () =>
    ipcRenderer.invoke('workspace:get-current'),
  createFile: (folderPath, fileName) =>
    ipcRenderer.invoke('workspace:create-file', { folderPath, fileName }),
  renameFile: (oldPath, newName) =>
    ipcRenderer.invoke('workspace:rename-file', { oldPath, newName }),
  deleteFile: (filePath) =>
    ipcRenderer.invoke('workspace:delete-file', { filePath }),
  getQuickOpenItems: () =>
  ipcRenderer.invoke('quick-open:get-items'),
onShowQuickOpen: (callback) =>
  ipcRenderer.on('show-quick-open', callback),
openWorkspace: () =>
  ipcRenderer.invoke('workspace:open'),
restoreWorkspace: (workspace) =>
  ipcRenderer.invoke('workspace:restore', workspace),
openWorkspaceFromPath: (rootFolder) =>
  ipcRenderer.invoke('workspace:open-from-path', rootFolder),
openTerminal: (dirPath = null) =>
  ipcRenderer.invoke('open-terminal', { dirPath }),
// コマンドパレット
getCommands: (workspaceRoot) => ipcRenderer.invoke('get-commands', workspaceRoot),
runCommand:  (commandDef, context) => ipcRenderer.invoke('run-command', { commandDef, context }),
removeHistoryItem: (filePath) =>
  ipcRenderer.invoke('quick-open:remove-item', filePath),
  
});
