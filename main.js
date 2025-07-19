const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const windows = new Set();

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('close', (event) => {
    event.preventDefault(); // ウィンドウが閉じるのを一旦キャンセル

    // レンダラープロセスに問い合わせて、ファイルのダーティ状態を確認
    win.webContents.send('before-close', { id: win.id });

    ipcMain.once(`is-dirty-${win.id}`, (e, isDirty) => {
      if (isDirty) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'question',
          buttons: ['Save', 'Don\'t Save', 'Cancel'],
          title: 'Confirm',
          message: 'You have unsaved changes. Do you want to save them?'
        });

        if (choice === 0) { // Save
          win.webContents.send('trigger-save-file', { id: win.id });
          ipcMain.once(`file-saved-${win.id}`, () => {
            win.destroy();
          });
        } else if (choice === 1) { // Don\'t Save
          win.destroy();
        }
        // choice === 2 (Cancel) の場合は何もしない
      } else {
        win.destroy();
      }
    });
  });

  win.on('closed', () => {
    windows.delete(win);
  });

  windows.add(win);
  return win;
}

// ファイルを新しいウィンドウで開く関数
async function openFileInNewWindow() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Text Files', extensions: ['txt', 'md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!canceled && filePaths.length > 0) {
    const filePath = filePaths[0];
    app.addRecentDocument(filePath);
    const newWindow = createWindow();
    newWindow.webContents.once('did-finish-load', () => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        newWindow.webContents.send('load-file', { filePath, content });
      } catch (e) {
        console.error('Failed to read file', e);
        // ここでユーザーにエラーを通知することもできます
      }
    });
  }
}

// ファイルを保存する処理
async function handleFileSave(event, { filePath, content }) {
  const webContents = event.sender
  const win = BrowserWindow.fromWebContents(webContents)
  if (filePath) {
    const contentToSave = content.replace(/\u200B/g, '');
    fs.writeFileSync(filePath, contentToSave);
    app.addRecentDocument(filePath);
    return filePath;
  } else {
    const firstLine = content.split('\n')[0].trim();
    let defaultName = '';
    if (firstLine) {
      // ファイル名に使えない文字を削除
      defaultName = firstLine.replace(/[/\\?%*:|"<>]/g, '') + '.md';
    }

    const { canceled, filePath: newFilePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text Document', extensions: ['txt'] },
      ]
    });

    if (canceled) {
      return;
    } else {
      const contentToSave = content.replace(/\u200B/g, '');
      fs.writeFileSync(newFilePath, contentToSave);
      return newFilePath;
    }
  }
}

// --- Step 3: レンダラープロセスからの通知を受け取り、タイトルを更新 ---
ipcMain.on('update-title', (event, { filePath, isDirty }) => {
  // 通知元のウィンドウを取得
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    let title = "Bext Editor"; // デフォルトタイトル
    if (filePath) {
      title = path.basename(filePath);
    }
    if (isDirty) {
      title = `*${title}`;
    }
    win.setTitle(title);
  }
});

app.setName('bextEditor');

const menuTemplate = [
  // {appMenu}
  ...(process.platform === 'darwin' ? [{
    label: app.getName(),
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }] : []),
  {
    label: 'File',
    submenu: [
      {
        label: 'New',
        accelerator: 'CmdOrCtrl+N',
        click: () => {
          createWindow();
        }
      },
      {
        label: 'Open File',
        accelerator: 'CmdOrCtrl+O',
        click: openFileInNewWindow
      },
      {
        label: 'Open Recent',
        role: 'recentDocuments',
        submenu: [
          {
            label: 'Clear Recent',
            role: 'clearRecentDocuments'
          }
        ]
      },
      {
        label: 'Save',
        accelerator: 'CmdOrCtrl+S',
        click: () => {
          const focusedWindow = BrowserWindow.getFocusedWindow();
          if (focusedWindow) {
            focusedWindow.webContents.send('trigger-save-file', { id: focusedWindow.id });
          }
        }
      },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(process.platform === 'darwin' ? [
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Speech',
          submenu: [
            { role: 'startSpeaking' },
            { role: 'stopSpeaking' }
          ]
        }
      ] : [
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ])
    ]
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
];

app.whenReady().then(() => {
  ipcMain.handle('dialog:saveFile', handleFileSave);

  ipcMain.handle('open-specific-file', async (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, filePath, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });


  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const iconimage = nativeImage.createFromPath(iconPath)
    app.dock.setIcon(iconimage);
  }

  createWindow();

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  app.on('activate', () => {
    if (windows.size === 0) {
      createWindow();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    // 新しいウィンドウを作成
    const newWindow = createWindow();
    // ファイルを読み込んでレンダラープロセスに送信
    newWindow.webContents.once('did-finish-load', () => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        newWindow.webContents.send('load-file', { filePath, content });
        app.addRecentDocument(filePath);
      } catch (e) {
        console.error('Failed to read file', e);
      }
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});