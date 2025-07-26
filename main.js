const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('electron-log')
const { program } = require ("commander")

console.log = (...args) => log.info(...args)
console.error = (...args) => log.error(...args)
console.warn = (...args) => log.warn(...args)

program
  .option("--allow-file-access-from-files")
  .option("--enable-avfoundation");


function parseArguments(args) {
  program.parse(args, {from: "user"})
  const binary = args[0];
  return path.basename(binary) === "Electron" ? program.args.slice(2) : program.args.slice(1)
}

// アプリ開始ログ
log.info('App is starting...')

let fileToOpen = null

if (!process.defaultApp && process.argv.length >= 2) {
  fileToOpen = process.argv[1];
}



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
    let title = "BextEditor"; // デフォルトタイトル
    if (filePath) {
      title = path.basename(filePath);
    }
    if (isDirty) {
      title = `*${title}`;
    }
    win.setTitle(title);
  }
});

//内部リンクの呼び出し
ipcMain.on("open-link", (event, linkText) => {
  console.log("リンククリック検知:", linkText);
  // 本格的なファイル呼び出しは後で実装
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

//引き数を使った起動への対応
let openFileQueue = []


function openFileFromPath(filePath) {
  console.log("ファイルから" + filePath + "ウィンドウを作成します")
  const newWindow = createWindow();
  newWindow.webContents.once('did-finish-load', () => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      newWindow.webContents.send('load-file', { filePath, content });
      app.addRecentDocument(filePath);
    } catch (e) {
      console.error('Failed to read file', e);
    }
  });
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  console.log('open-file received:', filePath)
  if (windows.size === 0) {
    //ウィンドウがないときの処理
    console.log('ウィンドウがありません')
  }
  //open コマンド起動時はこれが即座に開く
  if (app.isReady()) {
    console.log("アプリは起動しています")
    openFileFromPath(filePath)
    } else {
    console.log("アプリは起動していません")
    openFileQueue.push(filePath)
  }
  
});


app.on('will-finish-launching', () => {
  console.log('will-finish-launching');
});

app.on('ready', () => {
  console.log('ready event');
});

app.whenReady().then(() => {
  console.log("when ready start");
  ipcMain.handle('dialog:saveFile', handleFileSave);

  ipcMain.handle('open-specific-file', async (event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, filePath, content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  if (fileToOpen){
    console.log("コマンドライン引き数があるよ")
    openFileFromPath(fileToOpen)
    return
  }



  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    const iconimage = nativeImage.createFromPath(iconPath)
    app.dock.setIcon(iconimage);
  }



  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

 

  

  app.on('activate', (event, hasVisibleWindows) => {
    console.log("active" + event)
    if (windows.size === 0) {
      console.log("on active");
    }
  });

  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log("second-instance:初期")
    console.log("commandLine" + commandLine)
    openFileQueue.push(commandLine)
  })

   createWindow()

   console.log(openFileQueue)


});

app.on("second-instance", (_e,argv) => {
    // レンダラープロセスへファイルパスを送信
    console.log("second-instance" +argv)
    console.log("出力確認")
    console.log(parseArguments(argv))
    //files.forEach(openFileFromPath);
    //openFileFromPath(parseArguments(argv))
    //focusExistingWindow();
  });

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('bext-editor', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('bext-editor')
}

app.on('open-url', (event, url) => {
  dialog.showErrorBox('Welcome Back', `You arrived from: ${url}`)
  //You arrived from: bext-editor://
  //ファイルのパスをすべて入れるのは無理がある
})

app.on('window-all-closed', () => {
  app.quit();
});


function shiftDateInFilename(filePath, offsetDays) {
  const fileName = path.basename(filePath); // 例: 20250725.md
  const dirName = path.dirname(filePath);   // 例: Dropbox/logtext
  const match = fileName.match(/(\d{4})(\d{2})(\d{2})\.md$/);
  if (!match) return null;

  const [_, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}`);
  date.setDate(date.getDate() + offsetDays);

  const newDateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const newFileName = `${newDateStr}.md`;
  return path.join(dirName, newFileName); 
}

//ファイル移動のためのイベントリスナ
ipcMain.on("shift-file", async (event, currentPath,offsetDays) => {
  const newPath = shiftDateInFilename(currentPath,offsetDays);
  if (!newPath) {
    console.log("エラー", "ファイル名に日付が含まれていません。");
    return;
  }

  if (fs.existsSync(newPath)) {
    // 既存ファイルを開く
    console.log(newPath + "は存在しています");
    try {
       console.log(newPath + "を読み込みます");
      const content = fs.readFileSync(newPath, 'utf-8');
      event.sender.send("load-file", { filePath: newPath, content });
    } catch (e) {
      dialog.showErrorBox("読み込みエラー", `ファイル読み込みに失敗しました: ${newPath}`);
    }
  } else {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["作成", "キャンセル"],
      defaultId: 0,
      cancelId: 1,
      message: `${path.basename(newPath)} は存在しません。作成しますか？`
    });

    if (response === 0) {
      //fs.writeFileSync(newPath, ""); // 空ファイル作成
      //event.sender.send("open-file", newPath);
    }
  }
});
